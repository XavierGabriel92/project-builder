/**
 * Project Builder — Slash Commands
 *
 * Registers /project-builder command for interactive flow selection,
 * project naming, and workflow start/resume.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, Container, Editor, type Focusable, matchesKey, Text } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { EngineContext } from "./engine-context.ts";
import { allFlows } from "../../flows/index.ts";

export function registerCommands(pi: ExtensionAPI, engine: EngineContext, registerWidget: (ctx: ExtensionCommandContext) => void): void {
  pi.registerCommand("project-builder", {
    description: "Start or resume a project-builder workflow",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("project-builder requires interactive mode", "error");
        return;
      }

      const projectRoot = ctx.cwd;

      // Discover active workflows
      const runs = engine.list(projectRoot);
      const activeRuns = runs
        .map((fp) => ({ fp, state: engine.status(projectRoot, fp) }))
        .filter((r): r is { fp: string; state: NonNullable<ReturnType<EngineContext["status"]>> } =>
          r.state !== null && (r.state.status === "in_progress" || r.state.status === "awaiting_user")
        );

      let featurePath: string;
      let isResume = false;

      if (activeRuns.length > 0) {
        const options = activeRuns.map(
          (r) => `${r.state.feature} (${r.fp}) — [${r.state.status}]`
        );
        options.push("Start new project");

        const choice = await ctx.ui.select("Resume or start new?", options);
        if (choice === undefined) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        const startNewIndex = options.length - 1;
        const chosenIndex = options.indexOf(choice);

        if (chosenIndex !== startNewIndex) {
          featurePath = activeRuns[chosenIndex].fp;
          isResume = true;
        } else {
          const result = await startNewWorkflow(ctx, engine, projectRoot);
          if (!result) return;
          featurePath = result;
        }
      } else {
        const result = await startNewWorkflow(ctx, engine, projectRoot);
        if (!result) return;
        featurePath = result;
      }

      if (isResume) {
        registerWidget(ctx);
        const state = engine.status(projectRoot, featurePath)!;
        const currentStepInfo = state.steps[state.current_step_index];
        const stepLabel = currentStepInfo
          ? `step ${state.current_step_index + 1} (${currentStepInfo.agent})`
          : `step ${state.current_step_index + 1}`;
        ctx.ui.notify(`Resuming "${state.feature}" — ${stepLabel}`, "info");

        const message =
          `Please continue the workflow "${state.feature}" by calling \`flow_continue\` for feature path "${featurePath}".`;
        sendUserMessage(pi, ctx, message);
      } else {
        registerWidget(ctx);
        const state = engine.status(projectRoot, featurePath)!;
        ctx.ui.notify(`Workflow "${state.feature}" started.`, "info");

        const message =
          `The workflow "${state.feature}" has been started. Please call \`flow_step\` for feature path "${featurePath}" to begin the first step.`;
        sendUserMessage(pi, ctx, message);
      }
    },
  });
}

// ============================================================================
// Multi-line text input dialog (wraps Editor from pi-tui)
// ============================================================================

function buildEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text: string) => theme.fg("borderMuted", text),
    selectList: getSelectListTheme(),
  };
}

/**
 * A simple multi-line text input dialog using the Editor component.
 * Shows a title, the editor with word wrapping, and help text.
 * Submit with Enter, cancel with Escape, new line with Shift+Enter.
 *
 * Supports @ file references via CombinedAutocompleteProvider (fuzzy file
 * search scoped to the project root).
 */
class FeatureContextDialog extends Container implements Focusable {
  private editor: Editor;
  private tui: TUI;
  private piTheme: Theme;
  private onDone: (value: string | undefined) => void;
  private title: string;

  /** Focusable — propagate to child Editor for IME cursor positioning */
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  constructor(
    tui: TUI,
    piTheme: Theme,
    title: string,
    onDone: (value: string | undefined) => void,
    projectRoot: string,
  ) {
    super();
    this.tui = tui;
    this.piTheme = piTheme;
    this.title = title;
    this.onDone = onDone;

    // Top border
    this.addChild(new DynamicBorder((s: string) => piTheme.fg("accent", s)));

    // Title
    this.addChild(
      new Text(piTheme.fg("accent", piTheme.bold(title)), 1, 0),
    );

    // Editor with padding
    const editorTheme = buildEditorTheme(piTheme);
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.editor.onSubmit = (value: string) => {
      const trimmed = value.trim();
      onDone(trimmed || undefined);
    };
    // Enable @ file-reference autocomplete (fuzzy file search scoped to project root)
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider([], projectRoot),
    );
    this.addChild(this.editor);

    // Help text
    this.addChild(
      new Text(
        piTheme.fg("dim", "Shift+Enter for new line • Enter to submit • Esc to skip"),
        1,
        0,
      ),
    );

    // Bottom border
    this.addChild(new DynamicBorder((s: string) => piTheme.fg("accent", s)));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.onDone(undefined);
      return;
    }
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  override invalidate(): void {
    super.invalidate();
  }
}

/**
 * Show a multi-line text input dialog using the Editor component.
 * Returns the user's text, or undefined if cancelled.
 */
async function multilineInput(
  ctx: ExtensionCommandContext,
  title: string,
  projectRoot: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, piTheme, _kb, done) => {
    const dialog = new FeatureContextDialog(tui, piTheme, title, done, projectRoot);
    return {
      render: (width: number) => dialog.render(width),
      invalidate: () => dialog.invalidate(),
      handleInput: (data: string) => { dialog.handleInput(data); },
    };
  });
}

// ============================================================================
// Workflow start
// ============================================================================

async function startNewWorkflow(
  ctx: ExtensionCommandContext,
  engine: EngineContext,
  projectRoot: string
): Promise<string | undefined> {
  // Select flow
  const flowOptions = allFlows.map((f) => `${f.id}: ${f.description}`);
  const flowChoice = await ctx.ui.select("Select a flow", flowOptions);
  if (flowChoice === undefined) {
    ctx.ui.notify("Cancelled", "info");
    return undefined;
  }

  const flowIndex = flowOptions.indexOf(flowChoice);
  if (flowIndex < 0 || flowIndex >= allFlows.length) {
    ctx.ui.notify("Invalid flow selection", "error");
    return undefined;
  }
  const flow = allFlows[flowIndex];

  // Collect project name
  const featureName = await ctx.ui.input("Project / feature name", "e.g. user-auth");
  if (featureName === undefined || featureName.trim() === "") {
    ctx.ui.notify("Cancelled", "info");
    return undefined;
  }

  // Collect open-text description of what the user wants to build
  const featureContext = await multilineInput(
    ctx,
    "What do you want to build? (optional)",
    projectRoot,
  );
  // undefined means user cancelled the dialog (pressed Escape with empty text)
  // empty string means user submitted with no text — treat as no context
  if (featureContext === undefined) {
    ctx.ui.notify("Cancelled", "info");
    return undefined;
  }

  // Validate flow
  try {
    engine.validateFlows([flow]);
  } catch (err) {
    ctx.ui.notify(`Flow validation failed: ${(err as Error).message}`, "error");
    return undefined;
  }

  // Start workflow
  try {
    const context = featureContext.trim() || undefined;
    const result = engine.start(flow, featureName.trim(), projectRoot, { featureContext: context });
    return result.featurePath;
  } catch (err) {
    ctx.ui.notify(`Error starting flow: ${(err as Error).message}`, "error");
    return undefined;
  }
}

function sendUserMessage(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  message: string
): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
  } else {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  }
}
