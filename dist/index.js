import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createWorkflowSchema, handleCreateWorkflow, } from "./tools/create-workflow.js";
import { exportWorkflowSchema, handleExportWorkflow, } from "./tools/export-workflow.js";
// ─── Server setup ─────────────────────────────────────────────────────────
const server = new Server({
    name: "mcp-workflow-builder",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// ─── Tool list ────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "create_workflow",
                description: "Builds a workflow DAG from a structured list of intents and their relationships. The AI interface is responsible for extracting intents and detecting relationships from the user prompt before calling this tool.",
                inputSchema: zodToJsonSchema(createWorkflowSchema),
            },
            {
                name: "export_workflow",
                description: "Serializes a WorkflowDAG to JSON or YAML. Optionally writes to a file path. Always returns the serialized string.",
                inputSchema: zodToJsonSchema(exportWorkflowSchema),
            },
        ],
    };
});
// ─── Tool call handler ────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        let result;
        switch (name) {
            case "create_workflow": {
                const parsed = createWorkflowSchema.parse(args);
                result = await handleCreateWorkflow(parsed);
                break;
            }
            case "export_workflow": {
                const parsed = exportWorkflowSchema.parse(args);
                result = await handleExportWorkflow(parsed);
                break;
            }
            default:
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: `Unknown tool: ${name}` }),
                        },
                    ],
                    isError: true,
                };
        }
        return {
            content: [
                {
                    type: "text",
                    text: result,
                },
            ],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: message }),
                },
            ],
            isError: true,
        };
    }
});
// ─── Start server ─────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("mcp-workflow-builder server running on stdio");
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
