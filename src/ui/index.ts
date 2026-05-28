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
  const projectRoot = process.cwd();
  const agentsDir = resolveAgentsDir(projectRoot);
  const engine = createEngineContext(agentsDir);

  // Create the step-summary widget (reads engine state for rendering)
  const widget = new StepSummaryWidget(engine, projectRoot);

  // Register all flow_* tools (pass onStateChange callback so tools trigger widget refresh)
  registerTools(pi, engine, () => widget.notifyChange());

  // Register slash commands
  registerCommands(pi, engine);

  // Register the step-summary widget above the editor on session start
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

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
