/**
 * Project Builder — Slash Commands
 *
 * Registers /project-builder command for interactive flow selection,
 * project naming, and workflow start/resume.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { EngineContext } from "./engine-context.ts";
import { allFlows } from "../../flows/index.ts";

export function registerCommands(pi: ExtensionAPI, engine: EngineContext): void {
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
        const state = engine.status(projectRoot, featurePath)!;
        ctx.ui.notify(`Workflow "${state.feature}" started.`, "info");

        const message =
          `The workflow "${state.feature}" has been started. Please call \`flow_step\` for feature path "${featurePath}" to begin the first step.`;
        sendUserMessage(pi, ctx, message);
      }
    },
  });
}

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

  // Validate flow
  try {
    engine.validateFlows([flow]);
  } catch (err) {
    ctx.ui.notify(`Flow validation failed: ${(err as Error).message}`, "error");
    return undefined;
  }

  // Start workflow
  try {
    const result = engine.start(flow, featureName.trim(), projectRoot);
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
