// list_saved_workflows — enumerate the workflows the user has saved as skills.
import { z } from "zod";
import { listManifests, resolveSkillsDir } from "../lib/manifest-store.js";
export const listSavedWorkflowsSchema = z.object({
    skills_dir: z.string().optional().describe("Override the skills directory. Defaults to APS_SKILLS_DIR env or ~/.claude/skills."),
});
export async function handleListSavedWorkflows(input) {
    const workflows = listManifests(input.skills_dir);
    return {
        status: "success",
        skills_dir: resolveSkillsDir(input.skills_dir),
        count: workflows.length,
        workflows,
        next_action: workflows.length === 0
            ? "No saved workflows yet. Run a workflow, then call save_workflow_as_skill to create one."
            : "Run one with run_saved_workflow(slug=<slug>, inputs={...}), or invoke its /<slug> skill directly.",
    };
}
