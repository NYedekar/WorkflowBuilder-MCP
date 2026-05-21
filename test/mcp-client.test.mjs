// End-to-end MCP test harness.
// Spawns dist/index.js over stdio, drives it via the official SDK client,
// runs six scenarios, prints PASS/FAIL per check.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import yaml from "js-yaml";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_CMD = "node";
const SERVER_ARGS = [fileURLToPath(new URL("../dist/index.js", import.meta.url))];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  const tag = cond ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? "  — " + detail : ""}`);
}

function parseToolResult(res) {
  if (!res || !res.content || !res.content[0]) {
    throw new Error("Tool result missing content");
  }
  return res.content[0].text;
}

async function main() {
  const transport = new StdioClientTransport({
    command: SERVER_CMD,
    args: SERVER_ARGS,
  });
  const client = new Client(
    { name: "mcp-workflow-builder-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  // ─── 1. List tools ─────────────────────────────────────────────────────
  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  check(
    "listTools advertises create_workflow + export_workflow",
    JSON.stringify(names) === JSON.stringify(["create_workflow", "export_workflow"]),
    `got ${JSON.stringify(names)}`
  );
  for (const t of listed.tools) {
    check(
      `${t.name} has inputSchema`,
      t.inputSchema && t.inputSchema.type === "object",
      `type=${t.inputSchema?.type}`
    );
  }

  // ─── 2. Linear happy path ─────────────────────────────────────────────
  const linear = await client.callTool({
    name: "create_workflow",
    arguments: {
      name: "fetch-transform-send",
      description: "fetch a user, transform it, then email",
      intents: [
        { id: "i1", label: "Fetch user", type: "fetch", description: "Pull user", action: "fetch", entities: ["user"], parameters: {} },
        { id: "i2", label: "Format email", type: "transform", description: "Build payload", action: "format", entities: ["email"], parameters: {} },
        { id: "i3", label: "Send email", type: "send", description: "Send via SMTP", action: "send", entities: ["email"], parameters: {} },
      ],
      relationships: [
        { from: "i1", to: "i2", type: "sequential", confidence: 1 },
        { from: "i2", to: "i3", type: "sequential", confidence: 1 },
      ],
    },
  });
  const linearDag = JSON.parse(parseToolResult(linear));
  check("linear: nodes=3", linearDag.nodes.length === 3);
  check("linear: edges=2", linearDag.edges.length === 2);
  check("linear: no cycles", linearDag.metadata.has_cycles === false);
  check(
    "linear: execution_order is i1 → i2 → i3",
    JSON.stringify(linearDag.execution_order) ===
      JSON.stringify(["node_i1", "node_i2", "node_i3"])
  );
  const i2deps = linearDag.nodes.find((n) => n.id === "node_i2").dependencies;
  const i3deps = linearDag.nodes.find((n) => n.id === "node_i3").dependencies;
  check("linear: node_i2 depends on [node_i1]", JSON.stringify(i2deps) === JSON.stringify(["node_i1"]));
  check("linear: node_i3 depends on [node_i2]", JSON.stringify(i3deps) === JSON.stringify(["node_i2"]));
  check("linear: no parallel groups", linearDag.metadata.parallel_groups.length === 0);

  // ─── 3. Diamond DAG / parallel detection ──────────────────────────────
  const diamond = await client.callTool({
    name: "create_workflow",
    arguments: {
      name: "diamond",
      description: "A → {B,C} → D",
      intents: ["A", "B", "C", "D"].map((id) => ({
        id,
        label: id,
        type: "custom",
        description: id,
        action: id,
        entities: [],
        parameters: {},
      })),
      relationships: [
        { from: "A", to: "B", type: "sequential" },
        { from: "A", to: "C", type: "sequential" },
        { from: "B", to: "D", type: "sequential" },
        { from: "C", to: "D", type: "sequential" },
      ],
    },
  });
  const diamondDag = JSON.parse(parseToolResult(diamond));
  check("diamond: 4 nodes", diamondDag.nodes.length === 4);
  check("diamond: 4 edges", diamondDag.edges.length === 4);
  check("diamond: no cycles", diamondDag.metadata.has_cycles === false);
  // A must precede B,C; B,C must precede D
  const order = diamondDag.execution_order;
  const idx = (id) => order.indexOf(`node_${id}`);
  check("diamond: A before B", idx("A") < idx("B"));
  check("diamond: A before C", idx("A") < idx("C"));
  check("diamond: B before D", idx("B") < idx("D"));
  check("diamond: C before D", idx("C") < idx("D"));
  const groups = diamondDag.metadata.parallel_groups;
  const hasBCGroup = groups.some(
    (g) => g.includes("node_B") && g.includes("node_C") && g.length === 2
  );
  check(
    "diamond: parallel_groups contains [node_B, node_C]",
    hasBCGroup,
    `got ${JSON.stringify(groups)}`
  );

  // ─── 4. Cycle breaking ────────────────────────────────────────────────
  const cyclic = await client.callTool({
    name: "create_workflow",
    arguments: {
      name: "cycle",
      description: "A→B→C→A — weakest link is C→A",
      intents: ["A", "B", "C"].map((id) => ({
        id,
        label: id,
        type: "custom",
        description: id,
        action: id,
        entities: [],
        parameters: {},
      })),
      relationships: [
        { from: "A", to: "B", type: "sequential", confidence: 0.9 },
        { from: "B", to: "C", type: "sequential", confidence: 0.8 },
        { from: "C", to: "A", type: "loop", confidence: 0.3 },
      ],
    },
  });
  const cycDag = JSON.parse(parseToolResult(cyclic));
  check("cycle: has_cycles flag set", cycDag.metadata.has_cycles === true);
  check("cycle: weakest back-edge removed (2 edges remain)", cycDag.edges.length === 2);
  const cycEdgeIds = cycDag.edges.map((e) => e.id).sort();
  check(
    "cycle: kept A_B and B_C, dropped C_A",
    JSON.stringify(cycEdgeIds) === JSON.stringify(["A_B", "B_C"]),
    `got ${JSON.stringify(cycEdgeIds)}`
  );
  check(
    "cycle: execution_order completes for all 3 nodes",
    cycDag.execution_order.length === 3 &&
      JSON.stringify(cycDag.execution_order) === JSON.stringify(["node_A", "node_B", "node_C"])
  );

  // ─── 5. Export JSON / YAML / file ─────────────────────────────────────
  const exportJson = await client.callTool({
    name: "export_workflow",
    arguments: { workflow: linearDag, format: "json" },
  });
  const jsonStr = parseToolResult(exportJson);
  const roundTripped = JSON.parse(jsonStr);
  check(
    "export json: round-trips equal id+name",
    roundTripped.id === linearDag.id && roundTripped.name === linearDag.name
  );

  const exportYaml = await client.callTool({
    name: "export_workflow",
    arguments: { workflow: linearDag, format: "yaml" },
  });
  const yamlStr = parseToolResult(exportYaml);
  const yamlRT = yaml.load(yamlStr);
  check(
    "export yaml: round-trips equal id+name",
    yamlRT.id === linearDag.id && yamlRT.name === linearDag.name
  );
  check("export yaml: contains 'execution_order:'", yamlStr.includes("execution_order:"));

  // file write
  const tmp = mkdtempSync(join(tmpdir(), "mcpwf-"));
  const outPath = join(tmp, "out.yaml");
  const exportFile = await client.callTool({
    name: "export_workflow",
    arguments: { workflow: linearDag, format: "yaml", output_path: outPath },
  });
  parseToolResult(exportFile);
  check("export file: file exists at output_path", existsSync(outPath));
  if (existsSync(outPath)) {
    const onDisk = readFileSync(outPath, "utf8");
    const onDiskRT = yaml.load(onDisk);
    check("export file: on-disk YAML parses & id matches", onDiskRT.id === linearDag.id);
  }
  rmSync(tmp, { recursive: true, force: true });

  // accept workflow passed as a JSON *string* too
  const exportStrIn = await client.callTool({
    name: "export_workflow",
    arguments: { workflow: jsonStr, format: "json" },
  });
  const reJson = JSON.parse(parseToolResult(exportStrIn));
  check("export: accepts workflow as JSON string", reJson.id === linearDag.id);

  // ─── 6. Schema validation errors ──────────────────────────────────────
  const emptyIntents = await client.callTool({
    name: "create_workflow",
    arguments: { intents: [] },
  });
  check(
    "validation: empty intents → isError",
    emptyIntents.isError === true,
    parseToolResult(emptyIntents).slice(0, 120)
  );

  const badType = await client.callTool({
    name: "create_workflow",
    arguments: {
      intents: [
        {
          id: "x",
          label: "x",
          type: "not-a-real-type",
          description: "x",
          action: "x",
          entities: [],
          parameters: {},
        },
      ],
    },
  });
  check(
    "validation: bad intent type → isError",
    badType.isError === true,
    parseToolResult(badType).slice(0, 120)
  );

  const unknownTool = await client.callTool({
    name: "no_such_tool",
    arguments: {},
  });
  check(
    "validation: unknown tool name → isError",
    unknownTool.isError === true,
    parseToolResult(unknownTool).slice(0, 120)
  );

  // ─── Done ─────────────────────────────────────────────────────────────
  await client.close();

  const failed = results.filter((r) => !r.ok);
  console.log("\n──────────────────────────────────────────");
  console.log(`Summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(2);
});
