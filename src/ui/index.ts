/**
 * Project Builder — Extension Entry Point
 *
 * Pi extension that owns:
 * - Tool registration (flow_* tools)
 * - TUI dashboard (compact/expanded widget)
 * - Slash commands (/pb, /pb-expand, /pb-list, /pb-status)
 * - Gate dialog presentation
 *
 * The engine logic lives in src/engine/ (state machine, persistence, agent loading).
 * This UI layer wires it into Pi as tools, widgets, and commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEngineContext, resolveAgentsDir } from "./engine-context.ts";
import { registerTools } from "./tools.ts";
import { registerDashboard } from "./ui.ts";
import { registerCommands } from "./commands.ts";

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const projectRoot = process.cwd();
  const agentsDir = resolveAgentsDir(projectRoot);

  const engine = createEngineContext(agentsDir);

  // 1. Register all 8 flow_* tools
  registerTools(pi, engine);

  // 2. Register TUI dashboard widget
  registerDashboard(pi, engine, projectRoot);

  // 3. Register slash commands
  registerCommands(pi, engine);
}
