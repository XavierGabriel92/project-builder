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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEngineContext, resolveAgentsDir } from "./engine-context.ts";
import { registerTools } from "./tools.ts";
import { registerCommands } from "./commands.ts";
import { StepSummaryWidget } from "./step-summary-widget.ts";

export default function (pi: ExtensionAPI) {
  const agentsDir = resolveAgentsDir(process.cwd());
  const engine = createEngineContext(agentsDir);

  // Per-projectRoot widget instances so state is scoped to the active session.
  // Tools pass projectRoot → we look up the correct widget and notify it.
  const widgetsByProjectRoot = new Map<string, StepSummaryWidget>();

  // Register all flow_* tools (pass onStateChange callback so tools trigger widget refresh)
  registerTools(pi, engine, (projectRoot: string) => {
    widgetsByProjectRoot.get(projectRoot)?.notifyChange();
  });

  // Register slash commands
  registerCommands(pi, engine);

  // Register the step-summary widget above the editor on session start.
  // The widget is created per-session so it is scoped to the session's
  // project root and does not leak workflow state across sessions.
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    const projectRoot = ctx.cwd ?? process.cwd();
    const widget = new StepSummaryWidget(engine, projectRoot);
    widgetsByProjectRoot.set(projectRoot, widget);

    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
      // Wire the requestRender callback to the TUI
      widget.setRequestRender(() => _tui.requestRender());
      return {
        render: (width: number) => widget.render(width, theme),
        invalidate: () => widget.invalidate(),
      };
    });
  });

}

const WIDGET_KEY = "pb-step-summary";
