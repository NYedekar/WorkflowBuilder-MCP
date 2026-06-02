// Prompt builder (Phase 3) — exposes each saved workflow as an MCP prompt.
//
// MCP hosts (Claude Desktop, etc.) surface server prompts as slash commands. We map every saved
// workflow.json to a prompt whose name is the slug and whose arguments are the manifest inputs.
// Selecting the prompt injects a user message that instructs Claude to run the workflow
// deterministically via run_saved_workflow — so saved workflows become real slash commands in any
// MCP host, not just Claude Code, while still using the Phase-2 engine.

import { listManifests, loadManifest } from "./manifest-store.js";
import type { SkillInput } from "./skill-manifest.js";

// Structural shapes matching the MCP SDK's Prompt / GetPromptResult.
export interface PromptArg {
  name: string;
  description?: string;
  required?: boolean;
}
export interface PromptDef {
  name: string;
  description?: string;
  arguments?: PromptArg[];
}
export interface PromptResult {
  description: string;
  messages: { role: "user"; content: { type: "text"; text: string } }[];
}

function argDescription(i: SkillInput): string {
  if (i.type === "file_path") {
    return `${i.prompt} — a real Mac path (~/Downloads/, a local folder, or OneDrive).`;
  }
  if (i.type === "enum" && i.values?.length) {
    return `${i.prompt} — one of: ${i.values.join(", ")}${i.default !== undefined ? ` (default ${String(i.default)})` : ""}.`;
  }
  return i.prompt;
}

/** One MCP prompt per saved workflow. */
export function buildPromptList(skillsDir?: string): PromptDef[] {
  const prompts: PromptDef[] = [];
  for (const summary of listManifests(skillsDir)) {
    const loaded = loadManifest(summary.slug, skillsDir);
    if (!loaded.ok) continue;
    const m = loaded.manifest;
    prompts.push({
      name: m.slug,
      description: `Run saved workflow: ${m.name} — ${m.intent}`,
      arguments: m.inputs.map((i) => ({
        name: i.key,
        description: argDescription(i),
        required: i.required,
      })),
    });
  }
  return prompts;
}

/** The message a host injects when a saved-workflow prompt is selected. */
export function buildPromptMessages(
  name: string,
  args: Record<string, string> | undefined,
  skillsDir?: string
): PromptResult {
  const loaded = loadManifest(name, skillsDir);
  if (!loaded.ok) {
    throw new Error(`Unknown saved workflow '${name}'. ${loaded.error}`);
  }
  const m = loaded.manifest;
  const provided = args ?? {};

  const lines = m.inputs.map((i) => {
    const v = provided[i.key];
    if (v !== undefined && v !== "") return `- ${i.key}: ${v}`;
    if (i.required && i.default === undefined) return `- ${i.key}: (MISSING — ask me for this before running)`;
    return `- ${i.key}: (default ${JSON.stringify(i.default)})`;
  });

  const inputsObj: Record<string, string> = {};
  for (const i of m.inputs) {
    const v = provided[i.key];
    if (v !== undefined && v !== "") inputsObj[i.key] = v;
  }

  const text =
    `Run my saved workflow "${m.name}" (${m.intent}).\n\n` +
    (m.inputs.length ? `Inputs:\n${lines.join("\n")}\n\n` : "") +
    `Execute it deterministically: call run_saved_workflow(slug="${m.slug}", inputs=${JSON.stringify(inputsObj)}). ` +
    `If a Design Automation step returns status="pending" with a run_handle, call run_saved_workflow again ` +
    `with the SAME run_handle until it completes, then present the outputs. ` +
    `For any input marked MISSING above, ask me for it before running.`;

  return {
    description: `Run saved workflow: ${m.name}`,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}
