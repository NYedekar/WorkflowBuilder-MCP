// Manifest store — load and list saved workflow.json files written by save_workflow_as_skill.
// Shared by list_saved_workflows and run_saved_workflow (Phase 2).
//
// Layout: <skills_dir>/<slug>/workflow.json  (skills_dir defaults to ~/.claude/skills).
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { workflowManifestSchema } from "./skill-manifest.js";
/** Resolve the skills directory (same precedence as save_workflow_as_skill). */
export function resolveSkillsDir(override) {
    const raw = override ?? process.env.APS_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
    const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
    return resolve(expanded);
}
/** Load and validate a single saved workflow by slug. */
export function loadManifest(slug, skillsDir) {
    const dir = join(resolveSkillsDir(skillsDir), slug);
    const file = join(dir, "workflow.json");
    if (!existsSync(file)) {
        return {
            ok: false,
            error: `No saved workflow named '${slug}' (looked for ${file}).`,
            hint: "Call list_saved_workflows to see available slugs.",
        };
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, "utf8"));
    }
    catch (err) {
        return { ok: false, error: `Failed to parse ${file}: ${String(err)}` };
    }
    const parsed = workflowManifestSchema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false,
            error: `Saved workflow '${slug}' has an invalid manifest.`,
            hint: JSON.stringify(parsed.error.flatten()),
        };
    }
    return { ok: true, manifest: parsed.data, dir };
}
/** List every valid saved workflow in the skills directory. */
export function listManifests(skillsDir) {
    const root = resolveSkillsDir(skillsDir);
    if (!existsSync(root))
        return [];
    const out = [];
    for (const entry of readdirSync(root)) {
        const dir = join(root, entry);
        let isDir = false;
        try {
            isDir = statSync(dir).isDirectory();
        }
        catch {
            continue;
        }
        if (!isDir)
            continue;
        const res = loadManifest(entry, skillsDir);
        if (!res.ok)
            continue; // skip non-workflow skills and invalid manifests
        const m = res.manifest;
        out.push({
            slug: m.slug,
            name: m.name,
            intent: m.intent,
            auth_mode: m.auth_mode,
            step_count: m.steps.length,
            inputs: m.inputs.map((i) => ({ key: i.key, type: i.type, required: i.required })),
            created_at: m.created_at,
        });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
}
