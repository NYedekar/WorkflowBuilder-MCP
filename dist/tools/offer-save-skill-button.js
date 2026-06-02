// offer_save_skill_button (experimental, MCP Apps) — render an in-conversation "Save as skill"
// button. The tool is linked to the ui://workflow-builder/save-skill resource; its structuredContent
// carries the recipe, which the iframe uses to call back save_workflow_as_skill on click.
import { z } from "zod";
import { skillInputSchema, skillStepSchema, slugify } from "../lib/skill-manifest.js";
export const offerSaveSkillButtonSchema = z.object({
    name: z.string().min(1).describe("Proposed skill name (the user can edit it in the button UI)."),
    intent: z.string().min(1).describe("What this workflow accomplishes."),
    inputs: z.array(skillInputSchema).optional().default([]).describe("Per-run inputs (referenced in steps as {{key}})."),
    steps: z.array(skillStepSchema).min(1).describe("The exact ordered recipe you just ran."),
    auth_mode: z.enum(["2LO", "3LO", "auto"]).optional().default("auto"),
});
// Returns a CallToolResult with structuredContent (forwarded to the linked UI iframe).
export function handleOfferSaveSkillButton(input) {
    const recipe = {
        name: input.name,
        intent: input.intent,
        inputs: input.inputs,
        steps: input.steps,
        auth_mode: input.auth_mode,
        slug_hint: slugify(input.name),
    };
    return {
        content: [
            {
                type: "text",
                text: `Want to save this as a reusable skill — "${input.name}" (${input.steps.length} step(s))? ` +
                    `Click the "Save as skill" button above, or just say "yes" and I'll save it. ` +
                    `You'll be able to re-run it on any file later.`,
            },
        ],
        structuredContent: recipe,
    };
}
