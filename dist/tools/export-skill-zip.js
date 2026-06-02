// export_skill_for_claude — package a saved skill into a claude.ai-ready ZIP.
//
// There is NO supported API to push a personal skill into a user's claude.ai account
// (Anthropic: "Custom Skills do not sync across surfaces"). The realistic path is a manual
// ZIP upload via claude.ai → Settings/Customize → Skills. This tool produces a correctly
// structured ZIP (the skill folder as the archive ROOT, which claude.ai requires) so the only
// remaining step is the auth-gated upload click.
import { execFileSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { z } from "zod";
import { loadManifest, resolveSkillsDir } from "../lib/manifest-store.js";
export const exportSkillForClaudeSchema = z.object({
    slug: z.string().describe("The saved workflow's slug (from list_saved_workflows or save_workflow_as_skill)."),
    output_dir: z.string().optional().describe("Where to write the .zip. Defaults to ~/Downloads."),
    skills_dir: z.string().optional().describe("Override the skills directory. Defaults to APS_SKILLS_DIR env or ~/.claude/skills."),
});
function expandHome(p) {
    return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}
export async function handleExportSkillForClaude(input) {
    // Validate the skill exists and is a real saved workflow.
    const loaded = loadManifest(input.slug, input.skills_dir);
    if (!loaded.ok)
        return { status: "error", error: loaded.error, hint: loaded.hint };
    const skillsDir = resolveSkillsDir(input.skills_dir);
    const outDir = resolve(expandHome(input.output_dir ?? join(homedir(), "Downloads")));
    const zipPath = join(outDir, `${input.slug}.zip`);
    try {
        if (existsSync(zipPath))
            rmSync(zipPath);
        // Run from skillsDir and zip the slug DIRECTORY so the archive root is <slug>/SKILL.md
        // (claude.ai requires the skill folder as the ZIP root, not a subfolder).
        execFileSync("zip", ["-r", "-X", zipPath, input.slug], { cwd: skillsDir, stdio: "ignore" });
    }
    catch (err) {
        return {
            status: "error",
            error: `Failed to create ZIP: ${String(err)}`,
            hint: "Ensure the 'zip' command is available (macOS ships it) and the skill folder exists.",
        };
    }
    if (!existsSync(zipPath)) {
        return { status: "error", error: `ZIP was not created at ${zipPath}.` };
    }
    return {
        status: "success",
        slug: input.slug,
        zip_path: zipPath,
        upload_url: "https://claude.ai/customize/skills",
        steps: [
            `Open ${"https://claude.ai/customize/skills"} (or Claude Desktop → Settings → Capabilities/Skills).`,
            "Click the + button → Create skill.",
            `Upload the ZIP: ${zipPath}`,
            "It will sync to your Claude Desktop Skills panel within a moment.",
        ],
        caveat: "The skill drives this MCP server's tools (get_capability, execute_workflow, run_saved_workflow). " +
            "It runs wherever the workflow-builder MCP server is connected (e.g. Claude Desktop). " +
            "On plain claude.ai web with no MCP server connected, those tools are unavailable.",
        next_action: `ZIP ready at ${zipPath}. There is no API to auto-upload personal skills to claude.ai — ` +
            `tell the user to upload it via claude.ai/customize/skills → + → Create skill. It then syncs to the Desktop Skills panel.`,
    };
}
