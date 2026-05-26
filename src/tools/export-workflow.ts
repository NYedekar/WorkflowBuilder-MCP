import { writeFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { z } from "zod";
import yaml from "js-yaml";
import type { WorkflowDAG } from "../types.js";

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
    .describe(
      "Optional file path to write the output to. Must be within your home directory. " +
      "If omitted, returns the serialized content only."
    ),
});

export type ExportWorkflowInput = z.infer<typeof exportWorkflowSchema>;

export interface ExportWorkflowResult {
  status: "success" | "error";
  content?: string;
  file_written?: string;
  error?: string;
}

export async function handleExportWorkflow(
  input: ExportWorkflowInput
): Promise<ExportWorkflowResult> {
  // Parse workflow — accept either string or object
  let dag: WorkflowDAG;
  if (typeof input.workflow === "string") {
    try {
      dag = JSON.parse(input.workflow) as WorkflowDAG;
    } catch (err) {
      return { status: "error", error: `Failed to parse workflow JSON string: ${String(err)}` };
    }
  } else {
    dag = input.workflow as unknown as WorkflowDAG;
  }

  // Serialize
  let content: string;
  if (input.format === "json") {
    content = JSON.stringify(dag, null, 2);
  } else {
    content = yaml.dump(dag, { indent: 2, lineWidth: 120, noRefs: true });
  }

  // Write to file if path given
  if (input.output_path) {
    const resolvedPath = resolve(input.output_path);
    const homeDir = homedir();
    if (!resolvedPath.startsWith(homeDir)) {
      return {
        status: "error",
        error: `output_path must be within your home directory (${homeDir}). Received: '${resolvedPath}'`,
        content,
      };
    }
    try {
      writeFileSync(resolvedPath, content, "utf8");
    } catch (err) {
      return {
        status: "error",
        error: `Failed to write file at '${resolvedPath}': ${String(err)}`,
        content,
      };
    }
    return { status: "success", content, file_written: resolvedPath };
  }

  return { status: "success", content };
}
