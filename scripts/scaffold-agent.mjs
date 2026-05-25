#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const id = args.find((arg) => !arg.startsWith("--"));
const isSubagent = args.includes("--subagent");
const withApproval = args.includes("--approval");

if (!id) {
  console.error("Usage: scaffold-agent <id> [--approval] [--subagent]");
  process.exit(1);
}

if (isSubagent && withApproval) {
  console.error("--approval is only valid for main agents");
  process.exit(1);
}

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const agentsDir = path.join(rootDir, "agents");
const filePath = isSubagent
  ? path.join(agentsDir, "subagents", `${id}.md`)
  : path.join(agentsDir, `${id}.md`);

if (fs.existsSync(filePath)) {
  console.error(`Refusing to overwrite existing agent: ${filePath}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(filePath), { recursive: true });

const tools = isSubagent
  ? '["read", "bash"]'
  : withApproval
    ? '["ask_user_question", "read", "write"]'
    : '["read", "write", "bash"]';

const approval = withApproval
  ? `\napproval: {"header": "${id}", "preview": "${id}.md", "options": [{"label": "Approve", "description": "Proceed", "advance": true}, {"label": "Revise", "description": "Re-run this step", "advance": false}]}`
  : "";

const content = `---
id: ${id}
version: 1
tools: ${tools}${approval}
---

You are the **${id}** ${isSubagent ? "subagent" : "agent"}. Your job is to...

## Instructions

1. Define the task.
2. Produce the expected output.
${isSubagent ? "\nDo not ask user questions. Do not launch subagents." : "\nWhen complete, the supervisor will submit `step-result: success`."}
`;

fs.writeFileSync(filePath, content, "utf-8");
console.log(`Created ${filePath}`);
