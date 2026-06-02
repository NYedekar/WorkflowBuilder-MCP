// save_workflow_as_skill — freeze a just-executed workflow into a reusable Claude skill.
//
// Claude supplies the recipe it just ran (it has the trace in context). This tool:
//   1. validates every capability_id/operation_id against the registry (catches drift / hallucinated IDs),
//   2. derives auth_mode (2LO vs 3LO) from the resolved operations,
//   3. checks that every {{placeholder}} is a declared input (and warns on unused inputs),
//   4. enforces secret hygiene (no tokens/secrets baked into the manifest),
//   5. writes <skills_dir>/<slug>/{SKILL.md, workflow.json}.
//
// Purely additive — touches no existing tool or execution path.
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { z } from "zod";
import { skillInputSchema, skillStepSchema, workflowManifestSchema, collectStepPlaceholders, findSecrets, slugify, } from "../lib/skill-manifest.js";
import { renderSkillMd } from "../lib/skill-codegen.js";
import { findCapabilityById } from "../lib/registry-client.js";
const GENERATOR = "save_workflow_as_skill v1 (mcp-workflow-builder)";
// ── Schema ──────────────────────────────────────────────────────────────────
export const saveWorkflowAsSkillSchema = z.object({
    name: z
        .string()
        .min(1)
        .describe("Human-readable workflow name. Becomes the skill slug, e.g. 'Extract Revit room data' → 'extract-revit-room-data'."),
    intent: z
        .string()
        .min(1)
        .describe("The original user prompt / what this workflow accomplishes. Shown at the top of the skill."),
    description: z
        .string()
        .optional()
        .describe("Skill trigger description for the frontmatter — what it does AND when to invoke it (include trigger phrases). " +
        "If omitted, one is generated from name + intent."),
    auth_mode: z
        .enum(["2LO", "3LO", "auto"])
        .optional()
        .default("auto")
        .describe("Auth mode. 'auto' derives it from the resolved operations (3LO if any step needs user identity)."),
    inputs: z
        .array(skillInputSchema)
        .optional()
        .default([])
        .describe("The per-run parameter contract. Each input is referenced in steps as {{key}}."),
    steps: z
        .array(skillStepSchema)
        .min(1)
        .describe("The frozen ordered recipe — the exact capability operations you just ran, with fixed args and {{placeholders}}."),
    overwrite: z.boolean().optional().default(false).describe("Overwrite an existing skill of the same slug."),
    skills_dir: z
        .string()
        .optional()
        .describe("Override the skills directory. Defaults to APS_SKILLS_DIR env or ~/.claude/skills."),
});
// ── Helpers ──────────────────────────────────────────────────────────────────
function resolveSkillsDir(override) {
    const raw = override ?? process.env.APS_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
    const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
    return resolve(expanded);
}
/** Resolve a step's operation within its capability. Accepts operationId or globalOperationId. */
function resolveOperation(cap, operationId) {
    const q = operationId.toLowerCase();
    return cap.operations.find((o) => o.operationId.toLowerCase() === q || (o.globalOperationId ?? "").toLowerCase() === q);
}
/** Derive 2LO vs 3LO for a single resolved operation. */
function deriveAuth(op, cap) {
    const strategy = op.authStrategy ?? cap.authStrategy;
    if (strategy === "3LO")
        return "3LO";
    if (strategy === "2LO" || strategy === "either")
        return "2LO";
    const flows = (op.authFlows ?? cap.authFlows ?? []).map((f) => f.toLowerCase());
    if (flows.some((f) => f.includes("authorization_code") || f.includes("3lo") || f.includes("pkce")))
        return "3LO";
    return "2LO";
}
function defaultDescription(name, intent) {
    return (`${intent} ` +
        `Use when the user asks to "${name.toLowerCase()}", run this saved workflow, or re-run it with a different input.`);
}
// ── Handler ──────────────────────────────────────────────────────────────────
export async function handleSaveWorkflowAsSkill(input) {
    const warnings = [];
    const slug = slugify(input.name);
    // ── 1. Validate every step against the registry; derive auth ──────────────
    let derivedAuth = "2LO";
    for (const step of input.steps) {
        const cap = findCapabilityById(step.capability_id);
        if (!cap) {
            return {
                status: "error",
                error: `Step '${step.id}': capability_id '${step.capability_id}' not found in the registry.`,
                hint: "Use the exact capability_id returned by get_capability. A saved workflow can only freeze registered capabilities.",
            };
        }
        const op = resolveOperation(cap, step.operation_id);
        if (!op) {
            const available = cap.operations.slice(0, 8).map((o) => o.operationId).join(", ");
            return {
                status: "error",
                error: `Step '${step.id}': operation_id '${step.operation_id}' not found in capability '${cap.id}'.`,
                hint: `Available operations include: ${available}${cap.operations.length > 8 ? ", …" : ""}.`,
            };
        }
        if (op.callable === false) {
            return {
                status: "error",
                error: `Step '${step.id}': operation '${step.operation_id}' is not callable (documentation/SDK-only).`,
                hint: "Only callable operations can be frozen into a runnable skill.",
            };
        }
        if (deriveAuth(op, cap) === "3LO")
            derivedAuth = "3LO";
    }
    const authMode = input.auth_mode === "auto" ? derivedAuth : input.auth_mode;
    if (input.auth_mode !== "auto" && input.auth_mode !== derivedAuth) {
        warnings.push(`auth_mode was set to '${input.auth_mode}' but the resolved operations imply '${derivedAuth}'. Using '${input.auth_mode}' as requested.`);
    }
    // ── 2. Placeholder ↔ inputs consistency ───────────────────────────────────
    const referenced = collectStepPlaceholders(input.steps);
    const declared = new Set(input.inputs.map((i) => i.key));
    const undeclared = [...referenced].filter((k) => !declared.has(k));
    if (undeclared.length) {
        return {
            status: "error",
            error: `Steps reference {{placeholder}}(s) not declared in inputs: ${undeclared.join(", ")}.`,
            hint: "Add each referenced placeholder to inputs[] (with key, type, prompt), or replace it with a literal value.",
        };
    }
    const unused = [...declared].filter((k) => !referenced.has(k));
    if (unused.length)
        warnings.push(`Declared input(s) never referenced by any step: ${unused.join(", ")}.`);
    // enum inputs must declare values, and any default must be one of them
    for (const i of input.inputs) {
        if (i.type === "enum") {
            if (!i.values || i.values.length === 0) {
                return {
                    status: "error",
                    error: `Input '${i.key}' is type 'enum' but declares no 'values'.`,
                    hint: "Provide the allowed values, e.g. values: ['csv','json'].",
                };
            }
            if (i.default !== undefined && !i.values.includes(String(i.default))) {
                return {
                    status: "error",
                    error: `Input '${i.key}': default '${String(i.default)}' is not one of the allowed values [${i.values.join(", ")}].`,
                    hint: "Set default to one of the declared enum values, or drop it.",
                };
            }
        }
    }
    // ── 3. Secret hygiene ─────────────────────────────────────────────────────
    const secrets = findSecrets(input.steps);
    if (secrets.length) {
        return {
            status: "error",
            error: `Refusing to persist secret-like fields: ${secrets.map((s) => `${s.stepId}.${s.location}`).join(", ")}.`,
            hint: "Remove tokens/secrets from step args/config. Auth is handled at run time by authenticate_aps / authenticate_aps_3lo.",
        };
    }
    // ── 4. Build + validate the manifest ──────────────────────────────────────
    const manifest = {
        schema_version: 1,
        name: input.name,
        slug,
        intent: input.intent,
        description: (input.description ?? defaultDescription(input.name, input.intent)).trim(),
        auth_mode: authMode,
        inputs: input.inputs,
        steps: input.steps,
        created_at: new Date().toISOString(),
        generator: GENERATOR,
    };
    const parsed = workflowManifestSchema.safeParse(manifest);
    if (!parsed.success) {
        return { status: "error", error: "Manifest failed schema validation.", details: parsed.error.flatten() };
    }
    // ── 5. Write to the skills directory ──────────────────────────────────────
    const skillsDir = resolveSkillsDir(input.skills_dir);
    const home = homedir();
    if (!skillsDir.startsWith(home)) {
        return {
            status: "error",
            error: `skills_dir must be within your home directory (${home}). Resolved: '${skillsDir}'.`,
        };
    }
    const skillDir = join(skillsDir, slug);
    if (existsSync(skillDir) && !input.overwrite) {
        return {
            status: "error",
            error: `A skill named '${slug}' already exists at ${skillDir}.`,
            hint: "Pass overwrite=true to replace it, or choose a different name.",
        };
    }
    const skillMdPath = join(skillDir, "SKILL.md");
    const manifestPath = join(skillDir, "workflow.json");
    try {
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(skillMdPath, renderSkillMd(parsed.data), "utf8");
        writeFileSync(manifestPath, JSON.stringify(parsed.data, null, 2), "utf8");
    }
    catch (err) {
        return { status: "error", error: `Failed to write skill files: ${String(err)}` };
    }
    return {
        status: "success",
        slug,
        skill_dir: skillDir,
        skill_md: skillMdPath,
        manifest_path: manifestPath,
        invoke_hint: `/${slug}`,
        auth_mode: authMode,
        warnings,
        next_action: `Saved locally at ${skillDir} — usable now via /${slug} or run_saved_workflow(slug="${slug}"). ` +
            `Do NOT re-ask whether to save (it is already saved). Instead, present these next-step options to the user:\n` +
            `  • Add it to your Claude Desktop/web Skills panel? → call export_skill_for_claude(slug="${slug}") to drop an upload-ready ZIP in ~/Downloads, then give the claude.ai/customize/skills → + → Create skill upload steps.\n` +
            `  • Share it with a teammate? → same ZIP; note it only RUNS for someone who also has the workflow-builder MCP + APS access installed (it is not a standalone artifact).\n` +
            `  • Keep it local only? → nothing more needed.\n` +
            `Also mention: if /${slug} doesn't appear immediately, a Claude restart refreshes the skill list.`,
    };
}
