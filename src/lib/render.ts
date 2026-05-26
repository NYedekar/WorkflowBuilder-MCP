import type {
  IntentType,
  RelationshipType,
  WorkflowDAG,
  WorkflowEdge,
  WorkflowNode,
} from "../types.js";

const TYPE_LABELS: Record<IntentType, string> = {
  fetch: "FETCH",
  transform: "TRANSFORM",
  send: "SEND",
  store: "STORE",
  condition: "CONDITION",
  loop: "LOOP",
  trigger: "TRIGGER",
  custom: "CUSTOM",
};

const BOX_WIDTH = 46;

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? cur + " " + w : w;
    if (trial.length > width) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function renderBox(index: number, node: WorkflowNode): string[] {
  const inner = BOX_WIDTH - 2;
  const top = "┌" + "─".repeat(inner) + "┐";
  const bot = "└" + "─".repeat(inner) + "┘";
  const header = ` ${index}. ${TYPE_LABELS[node.type]}`;
  const labelLines = wrap(node.label, inner - 5);

  const body: string[] = ["│" + pad(header, inner) + "│"];
  for (const l of labelLines) {
    body.push("│" + pad("    " + l, inner) + "│");
  }
  return [top, ...body, bot];
}

function edgeLabel(edge: WorkflowEdge | undefined): string {
  if (!edge) return "(parallel branch — not a direct edge; see parallel groups below)";
  const base: Record<RelationshipType, string> = {
    sequential: "sequential",
    parallel: "parallel",
    conditional: "conditional",
    loop: "loop body",
    after_loop: "after loop",
    trigger: "trigger",
  };
  let label = base[edge.type] ?? String(edge.type);
  if (edge.condition) label += `: ${edge.condition}`;
  if (edge.confidence !== undefined && edge.confidence < 1) {
    label += ` (conf ${edge.confidence.toFixed(2)})`;
  }
  return label;
}

function findEdge(
  from: string,
  to: string,
  edges: WorkflowEdge[]
): WorkflowEdge | undefined {
  return edges.find((e) => e.from === from && e.to === to);
}

export function renderDagAscii(dag: WorkflowDAG): string {
  const order = dag.execution_order;
  const nodeById = new Map(dag.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];

  lines.push(`Workflow: ${dag.name}`);
  if (dag.description) {
    for (const l of wrap(dag.description, 70)) lines.push(l);
  }
  lines.push("");

  if (order.length === 0) {
    lines.push("(empty workflow — no nodes)");
    return lines.join("\n");
  }

  const arrowIndent = " ".repeat(Math.floor(BOX_WIDTH / 2) - 1);

  for (let i = 0; i < order.length; i++) {
    const node = nodeById.get(order[i]);
    if (!node) continue;
    for (const l of renderBox(i + 1, node)) lines.push(l);

    if (i < order.length - 1) {
      const edge = findEdge(order[i], order[i + 1], dag.edges);
      const label = edgeLabel(edge);
      lines.push(arrowIndent + "│");
      lines.push(arrowIndent + "│ " + label);
      lines.push(arrowIndent + "▼");
    }
  }

  lines.push("");
  lines.push(
    `nodes: ${dag.metadata.intent_count}  ` +
      `edges: ${dag.metadata.edge_count}  ` +
      `cycles: ${dag.metadata.has_cycles}  ` +
      `parallel_groups: ${dag.metadata.parallel_groups.length}`
  );

  if (dag.metadata.parallel_groups.length > 0) {
    lines.push("");
    lines.push("Parallel groups (can run concurrently):");
    for (const group of dag.metadata.parallel_groups) {
      const names = group
        .map((id) => nodeById.get(id)?.label ?? id)
        .join(", ");
      lines.push("  • " + names);
    }
  }

  if (dag.metadata.warnings && dag.metadata.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of dag.metadata.warnings) {
      lines.push("  ⚠ " + w);
    }
  }

  return lines.join("\n");
}
