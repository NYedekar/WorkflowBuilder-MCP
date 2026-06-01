// Workflow-skill manifest — the shared contract for "save this workflow as a skill".
//
// A manifest (workflow.json) freezes a multi-step APS workflow into a replayable recipe:
//   • steps[]  — the FROZEN ordered operations (capability_id + operation_id + fixed args)
//   • inputs[] — the parameter CONTRACT: which values vary per run, referenced as {{key}}
//
// It is consumed by TWO executors:
//   • Phase 1 — Claude reads the generated SKILL.md and calls the existing MCP tools in order.
//   • Phase 2 — a future deterministic engine (run_saved_workflow) walks steps[] honoring
//               depends_on / produces, threads OSS URLs between steps, and reuses the polling loop.
// Both read the SAME manifest. depends_on/produces are emitted now (ignored by Phase 1) so the
// engine needs zero contract changes later.

import { z } from "zod";

// ── Input parameter (the part that varies per run) ──────────────────────────

export const skillInputSchema = z.object({
  key: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "key must be a valid identifier (letters, digits, underscore; no leading digit)")
    .describe("Identifier referenced in steps as {{key}}. e.g. 'input_file', 'output_format'."),
  type: z
    .enum(["file_path", "string", "enum", "number", "boolean"])
    .default("string")
    .describe("Input type. 'file_path' is a local Mac path the skill will upload."),
  required: z.boolean().default(true),
  default: z.unknown().optional().describe("Default value when the user omits an optional input."),
  values: z.array(z.string()).optional().describe("Allowed values — required when type is 'enum'."),
  prompt: z.string().describe("Short prompt shown to the user when this input is needed."),
  description: z.string().optional(),
});
export type SkillInput = z.infer<typeof skillInputSchema>;

// ── Step (a single frozen capability operation) ─────────────────────────────

export const skillStepSchema = z.object({
  id: z.string().describe("Unique step id within this workflow, e.g. 's1'."),
  capability_id: z.string().describe("Frozen capability_id from get_capability. Validated against the registry at save time."),
  operation_id: z.string().describe("Frozen operation_id within the capability."),
  input_file_url: z
    .string()
    .optional()
    .describe("File input for this step. Use a {{placeholder}} for the per-run file, or a prior step's produces handle."),
  args: z
    .record(z.unknown())
    .optional()
    .describe("Fixed REST/Engine args. Literal values are frozen; {{placeholder}} values are filled from inputs at run time."),
  config: z.record(z.unknown()).optional().describe("Fixed Engine-API config block, if any."),
  depends_on: z
    .array(z.string())
    .default([])
    .describe("Step ids this step depends on. Drives ordering + file threading for the Phase-2 engine."),
  produces: z
    .string()
    .optional()
    .describe("Logical name for this step's output (e.g. 'rooms_csv'), referenceable by later steps' input_file_url."),
  note: z.string().optional().describe("Optional human note shown in the generated runbook."),
});
export type SkillStep = z.infer<typeof skillStepSchema>;

// ── Manifest (the persisted workflow.json) ──────────────────────────────────

export const AUTH_MODES = ["2LO", "3LO", "auto"] as const;

export const workflowManifestSchema = z.object({
  schema_version: z.literal(1),
  name: z.string(),
  slug: z.string(),
  intent: z.string().describe("The original user request / what this workflow accomplishes."),
  description: z.string().describe("Skill trigger description (frontmatter) — what it does + when to invoke."),
  auth_mode: z.enum(AUTH_MODES).default("auto"),
  inputs: z.array(skillInputSchema).default([]),
  steps: z.array(skillStepSchema).min(1),
  created_at: z.string(),
  generator: z.string().describe("Tool + version that produced this manifest."),
});
export type WorkflowManifest = z.infer<typeof workflowManifestSchema>;

// ── Helpers ─────────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** All {{placeholder}} keys referenced anywhere in a step's file/args/config. */
export function collectPlaceholders(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const m of value.matchAll(PLACEHOLDER_RE)) found.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectPlaceholders(v, found);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectPlaceholders(v, found);
  }
  return found;
}

/** All placeholders referenced across every step of a manifest-like object. */
export function collectStepPlaceholders(steps: Pick<SkillStep, "input_file_url" | "args" | "config">[]): Set<string> {
  const found = new Set<string>();
  for (const s of steps) {
    collectPlaceholders(s.input_file_url, found);
    collectPlaceholders(s.args, found);
    collectPlaceholders(s.config, found);
  }
  return found;
}

/** Convert a free-form name into a safe, stable skill slug. */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "saved-workflow";
}

// Keys/values that must never be baked into a persisted manifest (secret hygiene).
const SECRET_KEY_RE = /(secret|password|passwd|bearer|token|api[_-]?key|client[_-]?secret|authorization|credential)/i;

export interface SecretHit {
  stepId: string;
  location: string; // e.g. "args.bearer_token"
}

/** Scan steps for secret-looking keys. Returns every offending location. */
export function findSecrets(steps: SkillStep[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const s of steps) {
    const scan = (obj: Record<string, unknown> | undefined, base: string) => {
      if (!obj) return;
      for (const k of Object.keys(obj)) {
        if (SECRET_KEY_RE.test(k)) hits.push({ stepId: s.id, location: `${base}.${k}` });
      }
    };
    scan(s.args, "args");
    scan(s.config, "config");
  }
  return hits;
}
