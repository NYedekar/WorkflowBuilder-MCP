// render_viewer_poc — proof-of-concept tool that triggers the inline WebGL-cube MCP Apps UI.
// Validates the relay-free rendering channel end-to-end in Claude Desktop before we build the
// real SVF->glTF inline viewer. Returns structuredContent (small) to also exercise that channel.
import { z } from "zod";
export const renderViewerPocSchema = z.object({
    title: z
        .string()
        .optional()
        .default("WebGL POC · MCP Apps inline render")
        .describe("Optional title shown in the viewer HUD (delivered via structuredContent)."),
});
export function handleRenderViewerPoc(input) {
    return {
        content: [
            {
                type: "text",
                text: "Inline 3D POC: a rotating WebGL cube should render directly in the conversation above/with this tool result. " +
                    "If you see a spinning cube with 'rendering ✓', the relay-free MCP Apps channel works in this Claude build — " +
                    "we can then inline a real three.js + glTF model viewer the same way. " +
                    "If nothing renders, MCP Apps UI is not displaying in this host.",
            },
        ],
        structuredContent: { title: input.title },
    };
}
