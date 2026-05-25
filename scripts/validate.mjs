#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { allFlows } from "../flows/index.ts";
import { loadFlowAgents, validateFlowApproval } from "../src/orchestrator/agent-loader.ts";

const agentsDir = fileURLToPath(new URL("../agents", import.meta.url));
const errors = [];

for (const flow of allFlows) {
  try {
    const agents = loadFlowAgents(agentsDir, flow);
    validateFlowApproval(agentsDir, flow);
    console.log(`ok ${flow.id} v${flow.version} (${agents.size} agents)`);
  } catch (err) {
    errors.push(`Flow "${flow.id}": ${err.message}`);
  }
}

if (errors.length > 0) {
  console.error("Flow validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
}
