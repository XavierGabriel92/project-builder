/**
 * Project Builder — Extension Entry Point
 *
 * Registers flow_* tools that let the LLM drive the workflow engine,
 * and the /project-builder slash command for interactive workflow start/resume.
 *
 * Also registers the step-summary TUI widget above the editor that shows a
 * live expanded summary of the current workflow step while the orchestrator
 * LLM is executing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEngineContext, resolveAgentsDir } from "./engine-context.ts";
import { registerTools } from "./tools.ts";
import { registerCommands } from "./commands.ts";
import { StepSummaryWidget } from "./step-summary-widget.ts";

export default function (pi: ExtensionAPI) {
  const agentsDir = resolveAgentsDir(process.cwd());
  const engine = createEngineContext(agentsDir);

  // Per-session widget instances so state is fully scoped to the session
  // that initiated the workflow. No leakage across sessions in the same project root.
  const widgetsBySessionId = new Map<string, StepSummaryWidget>();

  /** Register the step-summary widget for the current session. Idempotent. */
  function registerWidget(projectRoot: string, ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (widgetsBySessionId.has(sessionId)) return;

    const widget = new StepSummaryWidget(engine, projectRoot);
    widgetsBySessionId.set(sessionId, widget);

    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
      widget.setRequestRender(() => _tui.requestRender());
      return {
        render: (width: number) => widget.render(width, theme),
        invalidate: () => widget.invalidate(),
      };
    });
  }

  // Register all flow_* tools (pass onStateChange + registerWidget callbacks)
  registerTools(pi, engine,
    (sessionId: string) => {
      widgetsBySessionId.get(sessionId)?.notifyChange();
    },
    (ctx: ExtensionContext) => {
      registerWidget(ctx.cwd, ctx);
    }
  );

  // Register slash commands (pass registerWidget for start/resume paths)
  registerCommands(pi, engine, (ctx) => {
    registerWidget(ctx.cwd, ctx);
  });

}

const WIDGET_KEY = "pb-step-summary";
