/**
 * Project Builder — Extension Entry Point
 *
 * Registers flow_* tools that let the LLM drive the workflow engine.
 * No TUI widgets, no slash commands — just tools and chat-based interaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEngineContext, resolveAgentsDir } from "./engine-context.ts";
import { registerTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
  const projectRoot = process.cwd();
  const agentsDir = resolveAgentsDir(projectRoot);
  const engine = createEngineContext(agentsDir);

  // Register all flow_* tools
  registerTools(pi, engine);
}
