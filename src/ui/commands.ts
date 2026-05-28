/**
 * Project Builder UI — Slash Commands
 *
 * Only one command: `/pb` — the workflow hub.
 * - No workflows → starts a new one
 * - Running/paused workflow(s) → pick one → auto-resumes
 * - Done workflow(s) → shows status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { EngineContext } from "./engine-context.ts";
import { toggleDashboardExpand, showDashboard, hideDashboard } from "./ui.ts";

export function registerCommands(pi: ExtensionAPI, engine: EngineContext): void {
  const projectRoot = process.cwd();

  // ---------------------------------------------------------------------------
  // /pb — The one command: list, pick, start, resume
  // ---------------------------------------------------------------------------
  pi.registerCommand("pb", {
    description: "Workflow hub: list, start new, or resume workflows",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // If a feature path was given directly, show its status
      if (args.trim()) {
        const current = engine.status(projectRoot, args.trim());
        if (current) {
          showStepStatus(ctx, current);
        } else {
          ctx.ui.notify(`No workflow found at "${args.trim()}".`, "info");
        }
        return;
      }

      // No args — list runs and show interactive hub
      const runs = engine.list(projectRoot);

      if (runs.length === 0) {
        // No workflows at all — ask user what to build
        const name = await ctx.ui.input("What do you want to build?", "e.g. user-auth");
        if (name?.trim()) {
          startNewWorkflow(pi, name.trim());
          showDashboard(ctx, engine, projectRoot);
        }
        return;
      }

      if (runs.length === 1) {
        // Single workflow — auto-resume if active, otherwise show status
        const current = engine.status(projectRoot, runs[0]);
        if (current) {
          showDashboard(ctx, engine, projectRoot);
          if (current.status === "in_progress" || current.status === "awaiting_user") {
            resumeWorkflow(pi, engine, projectRoot, runs[0]);
          } else {
            showStepStatus(ctx, current);
          }
        }
        return;
      }

      // Multiple workflows — let the user pick one
      const items = runs.map((fp) => {
        const st = engine.status(projectRoot, fp);
        const icon = statusIcon(st?.status);
        const stepInfo = st ? `step ${st.current_step_index + 1}/${st.steps.length}` : "?";
        return {
          value: fp,
          label: `${icon} ${st?.feature ?? fp}`,
          description: `${st?.flow_id ?? "?"} · ${stepInfo} · ${st?.status ?? "?"}`,
        };
      });

      // Add "Start new" and "Hide dashboard" options
      items.unshift(
        { value: "__hide__", label: "✕ Hide dashboard", description: "Hide the dashboard widget" },
        { value: "__expand__", label: "⤢ Toggle expanded view", description: "Show/hide agent details" },
        { value: "__new__", label: "➕ Start a new workflow", description: "Begin a new feature-build flow" },
      );

      const choice = await ctx.ui.select("Pick a workflow:", items.map((i) => i.label));
      if (!choice) return;

      const picked = items.find((i) => i.label === choice);
      if (!picked) return;

      if (picked.value === "__new__") {
        const name = await ctx.ui.input("What do you want to build?", "e.g. user-auth");
        if (name?.trim()) startNewWorkflow(pi, name.trim());
        return;
      }

      if (picked.value === "__hide__") {
        hideDashboard(ctx);
        return;
      }

      if (picked.value === "__expand__") {
        toggleDashboardExpand();
        showDashboard(ctx, engine, projectRoot);
        return;
      }

      // Existing workflow picked
      const current = engine.status(projectRoot, picked.value);
      if (current) {
        showDashboard(ctx, engine, projectRoot);
        if (current.status === "in_progress" || current.status === "awaiting_user") {
          resumeWorkflow(pi, engine, projectRoot, picked.value);
        } else {
          showStepStatus(ctx, current);
        }
      }
    },
  });
}

// ============================================================================
// Helpers
// ============================================================================

/** Resume a workflow by telling the LLM to continue working on it */
function resumeWorkflow(pi: ExtensionAPI, engine: EngineContext, projectRoot: string, featurePath: string): void {
  const st = engine.status(projectRoot, featurePath);
  if (!st) return;

  pi.sendUserMessage(
    `Continue the "${st.feature}" workflow at ${featurePath}. Call flow_continue with featurePath: "${featurePath}" and resume working. Do not ask questions — just pick up where we left off.`,
    { triggerTurn: true }
  );
}

function statusIcon(status: string | undefined): string {
  switch (status) {
    case "done": return "✅";
    case "blocked": return "❌";
    case "awaiting_user": return "⛔";
    case "abandoned": return "🛑";
    case "in_progress": return "⏳";
    default: return "◦";
  }
}

function showStepStatus(ctx: ExtensionCommandContext, st: import("../shared/types.ts").WorkflowState): void {
  const total = st.steps.length;
  const completed = st.steps.filter((s) => s.status === "completed").length;
  const running = st.steps.filter((s) => s.status === "running").length;
  const failed = st.steps.filter((s) => s.status === "failed").length;

  ctx.ui.notify(
    `${statusIcon(st.status)} ${st.flow_id} v${st.flow_version} · ${st.feature} · ${st.status} · ${completed}/${total} done${running ? ` (${running} running)` : ""}${failed ? ` (${failed} failed)` : ""}`,
    "info"
  );

  // Step list
  for (const step of st.steps) {
    const icon = step.status === "completed" ? "✓"
      : step.status === "failed" ? "✗"
      : step.status === "running" ? "⏳"
      : "◦";
    const marker = step.index === st.current_step_index ? "▶" : " ";
    const attempt = step.attempt > 1 ? ` (attempt ${step.attempt})` : "";
    const activity = step.activity?.message ?? "";
    ctx.ui.notify(
      `  ${marker} ${icon} Step ${step.index + 1}: ${step.agent} · ${step.status}${attempt}${activity ? ` · ${activity}` : ""}`,
      "info"
    );
  }

  if (st.gate) {
    ctx.ui.notify(`⛔ Awaiting approval: ${st.gate.header}`, "warning");
  }
}

/** Full flow definition for the built-in feature-build pipeline */
const FEATURE_BUILD_FLOW = JSON.stringify({
  id: "feature-build",
  version: 1,
  description: "Full product feature build from input gathering to completion docs",
  steps: [
    { agent: "gather-input", requestApproval: true },
    { agent: "discover" },
    { agent: "clarify", requestApproval: true },
    { agent: "spec-write", requestApproval: true },
    { agent: "research", requestApproval: true },
    { agent: "plan", requestApproval: true, attempts: 2 },
    { agent: "implement", attempts: 2 },
    { agent: "review" },
    { agent: "doc-sync" },
    { agent: "complete" },
  ],
});

/** Send a message to the LLM to start a new feature-build workflow */
function startNewWorkflow(pi: ExtensionAPI, name: string): void {
  pi.sendUserMessage([
    {
      type: "text",
      text:
`Start a new feature-build flow for "${name}".

Use the **flow_start** tool with this flow definition:

\`\`\`json
${FEATURE_BUILD_FLOW}
\`\`\`

Set projectRoot to process.cwd(). Do not read any files, explore the project, or ask questions — just call flow_start immediately and proceed with flow_step.`,
    },
  ], { triggerTurn: true });
}
