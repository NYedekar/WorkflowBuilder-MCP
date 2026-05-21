import { writeFileSync } from "fs";
import { z } from "zod";
import yaml from "js-yaml";
// Zod schema for WorkflowDAG input (accepting a full WorkflowDAG object or its JSON string)
export const exportWorkflowSchema = z.object({
    workflow: z
        .union([z.string(), z.record(z.unknown())])
        .describe("The WorkflowDAG object (or its JSON string) to export"),
    format: z
        .enum(["json", "yaml"])
        .describe("Output format: 'json' or 'yaml'"),
    output_path: z
        .string()
        .optional()
        .describe("Optional file path to write the output to. If omitted, returns the serialized string only."),
});
export async function handleExportWorkflow(input) {
    // Parse workflow — accept either string or object
    let dag;
    if (typeof input.workflow === "string") {
        try {
            dag = JSON.parse(input.workflow);
        }
        catch (err) {
            return JSON.stringify({ error: `Failed to parse workflow JSON string: ${String(err)}` }, null, 2);
        }
    }
    else {
        dag = input.workflow;
    }
    // Serialize
    let serialized;
    if (input.format === "json") {
        serialized = JSON.stringify(dag, null, 2);
    }
    else {
        // YAML via js-yaml
        serialized = yaml.dump(dag, {
            indent: 2,
            lineWidth: 120,
            noRefs: true,
        });
    }
    // Write to file if path given
    if (input.output_path) {
        try {
            writeFileSync(input.output_path, serialized, "utf8");
        }
        catch (err) {
            return JSON.stringify({
                error: `Failed to write file at '${input.output_path}': ${String(err)}`,
                content: serialized,
            }, null, 2);
        }
    }
    return serialized;
}
