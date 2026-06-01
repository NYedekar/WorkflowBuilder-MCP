/**
 * Loop-completion semantics tests — RFC v4 (V1–V22)
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDAG } from "../dist/lib/dag-builder.js";
import fixture from "./fixtures/regression-loop-completion.json" with { type: "json" };

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mkNode = (id, type) => ({
  id, label: id, type,
  description: id, action: type,
  entities: [], parameters: {},
});
const loop      = (id) => mkNode(id, "loop");
const fetch_    = (id) => mkNode(id, "fetch");
const transform = (id) => mkNode(id, "transform");
const store     = (id) => mkNode(id, "store");

const rel = (from, to, type, confidence = 1.0) => ({ from, to, type, confidence });

// ─── V1: Baseline — 1 body, 1 after-loop ──────────────────────────────────────

test("V1: bodyA and afterA not in same parallel group; afterA depends on bodyA", () => {
  const dag = buildDAG(
    [loop("L"), fetch_("bodyA"), fetch_("afterA")],
    [rel("L", "bodyA", "loop"), rel("L", "afterA", "after_loop")],
    "V1", ""
  );
  const bad = dag.metadata.parallel_groups.find(
    g => g.includes("node_bodyA") && g.includes("node_afterA")
  );
  assert.equal(bad, undefined, "bodyA and afterA must not be parallel");
  const afterA = dag.nodes.find(n => n.id === "node_afterA");
  assert.ok(afterA.dependencies.includes("node_bodyA"), "afterA must depend on bodyA");
});

// ─── V2: 2 body nodes ─────────────────────────────────────────────────────────

test("V2: 2 body nodes — both parallel to each other; both gate afterA", () => {
  const dag = buildDAG(
    [loop("L"), fetch_("bodyA"), fetch_("bodyB"), fetch_("afterA")],
    [rel("L", "bodyA", "loop"), rel("L", "bodyB", "loop"), rel("L", "afterA", "after_loop")],
    "V2", ""
  );
  const bodiesParallel = dag.metadata.parallel_groups.find(
    g => g.includes("node_bodyA") && g.includes("node_bodyB")
  );
  assert.ok(bodiesParallel, "bodyA and bodyB should be parallel");
  const afterA = dag.nodes.find(n => n.id === "node_afterA");
  assert.ok(afterA.dependencies.includes("node_bodyA"), "afterA must depend on bodyA");
  assert.ok(afterA.dependencies.includes("node_bodyB"), "afterA must depend on bodyB");
});

// ─── V3: 2 after-loop nodes ───────────────────────────────────────────────────

test("V3: 2 after-loop nodes — afterA/afterB may be parallel; neither parallel with body", () => {
  const dag = buildDAG(
    [loop("L"), fetch_("bodyA"), fetch_("afterA"), fetch_("afterB")],
    [rel("L", "bodyA", "loop"), rel("L", "afterA", "after_loop"), rel("L", "afterB", "after_loop")],
    "V3", ""
  );
  const bad = dag.metadata.parallel_groups.find(
    g => (g.includes("node_afterA") || g.includes("node_afterB")) && g.includes("node_bodyA")
  );
  assert.equal(bad, undefined, "body must not be parallel with any after-loop node");
  const parallelAfter = dag.metadata.parallel_groups.find(
    g => g.includes("node_afterA") && g.includes("node_afterB")
  );
  assert.ok(parallelAfter, "afterA and afterB should be parallel");
});

// ─── V4: Nested loops ─────────────────────────────────────────────────────────

test("V4: nested loops — outer after-loop gated on inner body closure", () => {
  const dag = buildDAG(
    [loop("Lo"), loop("Li"), fetch_("B"), fetch_("Ai"), fetch_("Ao")],
    [
      rel("Lo", "Li", "loop"),
      rel("Lo", "Ao", "after_loop"),
      rel("Li", "B", "loop"),
      rel("Li", "Ai", "after_loop"),
    ],
    "V4", ""
  );
  const Ao = dag.nodes.find(n => n.id === "node_Ao");
  // Ao must depend on nodes in inner body closure (Li, B, Ai)
  const closureDeps = ["node_Li", "node_B", "node_Ai"].filter(id => Ao.dependencies.includes(id));
  assert.ok(closureDeps.length > 0, `Ao must depend on inner closure; got: ${Ao.dependencies.join(", ")}`);
});

// ─── V5: Conditional inside loop body ─────────────────────────────────────────

test("V5: conditional branch inside body — afterA gated on full closure", () => {
  const dag = buildDAG(
    [loop("L"), fetch_("bodyA"), fetch_("branchA"), fetch_("afterA")],
    [
      rel("L", "bodyA", "loop"),
      rel("bodyA", "branchA", "conditional"),
      rel("L", "afterA", "after_loop"),
    ],
    "V5", ""
  );
  const bad = dag.metadata.parallel_groups.find(
    g => g.includes("node_afterA") && (g.includes("node_bodyA") || g.includes("node_branchA"))
  );
  assert.equal(bad, undefined, "afterA must not be parallel with body closure nodes");
  const afterA = dag.nodes.find(n => n.id === "node_afterA");
  const gated =
    afterA.dependencies.includes("node_bodyA") ||
    afterA.dependencies.includes("node_branchA");
  assert.ok(gated, "afterA must depend on at least one body closure node");
});

// ─── V6: Auto-promotion deprecation warning ───────────────────────────────────

test("V6: sequential from loop → auto-promoted to after_loop with deprecation warning", () => {
  const dag = buildDAG(
    [loop("L"), fetch_("bodyA"), fetch_("afterA")],
    [rel("L", "bodyA", "loop"), rel("L", "afterA", "sequential")],
    "V6", ""
  );
  // V1 assertions hold
  const bad = dag.metadata.parallel_groups.find(
    g => g.includes("node_bodyA") && g.includes("node_afterA")
  );
  assert.equal(bad, undefined, "bodyA and afterA must not be parallel after promotion");
  const afterA = dag.nodes.find(n => n.id === "node_afterA");
  assert.ok(afterA.dependencies.includes("node_bodyA"), "afterA must depend on bodyA");
  // Deprecation warning
  assert.ok(dag.metadata.warnings.length > 0, "deprecation warning must be emitted");
  assert.match(
    dag.metadata.warnings[0],
    /^\[deprecation\] Edge .+ auto-promoted: 'sequential' → 'after_loop'/
  );
});

// ─── V7: Rejection — explicit after_loop + sequential from same loop ───────────

test("V7: reject — sequential + explicit after_loop from same loop node is ambiguous", () => {
  assert.throws(
    () => buildDAG(
      [loop("L"), fetch_("bodyA"), fetch_("afterA")],
      [
        rel("L", "bodyA", "loop"),
        rel("L", "afterA", "after_loop"),
        rel("L", "afterA", "sequential"),
      ],
      "V7", ""
    ),
    /ambiguous/
  );
});

// ─── V8: Loop with body only — no continuation ────────────────────────────────

test("V8: body only, no after-loop — no warnings, no synthetic deps", () => {
  const dag = buildDAG(
    [loop("L"), fetch_("bodyA")],
    [rel("L", "bodyA", "loop")],
    "V8", ""
  );
  assert.equal(dag.metadata.warnings.length, 0);
  // bodyA has no synthetic inbound deps
  const bodyA = dag.nodes.find(n => n.id === "node_bodyA");
  const syntheticDeps = dag.nodes.filter(n => n.dependencies.some(d => d.startsWith("__synth")));
  assert.equal(syntheticDeps.length, 0);
});

// ─── V9: Smoking-gun regression ───────────────────────────────────────────────

test("V9: regression — load_file and run_clash_detection must NOT be parallel", () => {
  const dag = buildDAG(
    fixture.intents,
    fixture.relationships,
    fixture.name,
    fixture.description
  );
  const bad = dag.metadata.parallel_groups.find(
    g => g.includes("node_load_file") && g.includes("node_run_clash_detection")
  );
  assert.equal(bad, undefined, "load_file and run_clash_detection must not share a parallel group");
  assert.ok(dag.metadata.warnings.length > 0, "auto-promotion warning expected for fixture");
});

// ─── V10: Determinism ─────────────────────────────────────────────────────────

test("V10: determinism — identical execution_order and parallel_groups across 10 runs", () => {
  const run = () => buildDAG(
    [loop("L"), fetch_("bodyA"), fetch_("afterA")],
    [rel("L", "bodyA", "loop"), rel("L", "afterA", "after_loop")],
    "V10", ""
  );
  const first = run();
  for (let i = 0; i < 9; i++) {
    const r = run();
    assert.deepEqual(r.execution_order, first.execution_order);
    assert.deepEqual(r.metadata.parallel_groups, first.metadata.parallel_groups);
  }
});

// ─── V11: Caller-defined cycle involving after_loop ───────────────────────────

test("V11: cycle in non-loop nodes — broken by cycle detection; pipeline proceeds", () => {
  // afterA ↔ X forms a cycle; L's loop body is unaffected
  assert.doesNotThrow(() => buildDAG(
    [loop("L"), fetch_("bodyA"), fetch_("afterA"), fetch_("X")],
    [
      rel("L", "bodyA", "loop"),
      rel("L", "afterA", "after_loop"),
      rel("afterA", "X", "sequential"),
      rel("X", "afterA", "sequential"),
    ],
    "V11", ""
  ));
});

// ─── V12: Synthetic-induced cycle ─────────────────────────────────────────────

test("V12: reject — after-loop target has caller path back to body node", () => {
  assert.throws(
    () => buildDAG(
      [loop("L"), fetch_("bodyA"), fetch_("afterA")],
      [
        rel("L", "bodyA", "loop"),
        rel("L", "afterA", "after_loop"),
        rel("afterA", "bodyA", "sequential"),
      ],
      "V12", ""
    ),
    /after-loop target has a caller-defined path back to a body node/
  );
});

// ─── V13: after_loop from non-loop node ───────────────────────────────────────

test("V13: reject — after_loop edge from non-loop node", () => {
  assert.throws(
    () => buildDAG(
      [fetch_("A"), fetch_("B")],
      [rel("A", "B", "after_loop")],
      "V13", ""
    ),
    /after_loop edge from non-loop node/
  );
});

// ─── V14: Loop node with no body ──────────────────────────────────────────────

test("V14: reject — loop node has no body edge", () => {
  assert.throws(
    () => buildDAG(
      [loop("L"), fetch_("afterA")],
      [rel("L", "afterA", "after_loop")],
      "V14", ""
    ),
    /loop node has no body/
  );
});

// ─── V15: Forbidden edge types from loop node ─────────────────────────────────

test("V15a: reject — parallel edge from loop node", () => {
  assert.throws(
    () => buildDAG(
      [loop("L"), fetch_("bodyA"), fetch_("X")],
      [rel("L", "bodyA", "loop"), rel("L", "X", "parallel")],
      "V15a", ""
    ),
    /edge type 'parallel' not supported from a loop node/
  );
});

test("V15b: reject — conditional edge from loop node", () => {
  assert.throws(
    () => buildDAG(
      [loop("L"), fetch_("bodyA"), fetch_("X")],
      [rel("L", "bodyA", "loop"), rel("L", "X", "conditional")],
      "V15b", ""
    ),
    /edge type 'conditional' not supported from a loop node/
  );
});

test("V15c: reject — trigger edge from loop node", () => {
  assert.throws(
    () => buildDAG(
      [loop("L"), fetch_("bodyA"), fetch_("X")],
      [rel("L", "bodyA", "loop"), rel("L", "X", "trigger")],
      "V15c", ""
    ),
    /edge type 'trigger' not supported from a loop node/
  );
});

// ─── V16: Sibling loops ───────────────────────────────────────────────────────

test("V16: sibling loops — each after-loop gated only on its own body", () => {
  const dag = buildDAG(
    [
      fetch_("pre"),
      loop("L1"), fetch_("body1"), fetch_("after1"),
      loop("L2"), fetch_("body2"), fetch_("after2"),
    ],
    [
      rel("pre", "L1", "sequential"), rel("pre", "L2", "sequential"),
      rel("L1", "body1", "loop"), rel("L1", "after1", "after_loop"),
      rel("L2", "body2", "loop"), rel("L2", "after2", "after_loop"),
    ],
    "V16", ""
  );
  const after1 = dag.nodes.find(n => n.id === "node_after1");
  const after2 = dag.nodes.find(n => n.id === "node_after2");
  assert.ok(!after1.dependencies.includes("node_body2"), "after1 must not depend on body2");
  assert.ok(!after2.dependencies.includes("node_body1"), "after2 must not depend on body1");
});

// ─── V17: Terminal body node ──────────────────────────────────────────────────

test("V17: terminal body node (no outgoing edges) — afterA still gated on it", () => {
  const dag = buildDAG(
    [loop("L"), fetch_("bodyA"), fetch_("afterA")],
    [rel("L", "bodyA", "loop"), rel("L", "afterA", "after_loop")],
    "V17", ""
  );
  const afterA = dag.nodes.find(n => n.id === "node_afterA");
  assert.ok(afterA.dependencies.includes("node_bodyA"), "afterA must depend on terminal bodyA");
});

// ─── V18: Self-loop on loop node ──────────────────────────────────────────────

test("V18: reject — loop node with self-referential edge", () => {
  assert.throws(
    () => buildDAG(
      [loop("L"), fetch_("bodyA")],
      [rel("L", "bodyA", "loop"), rel("L", "L", "loop")],
      "V18", ""
    ),
    /loop node has a self-referential edge/
  );
});

// ─── V19: Body closure — all unreachable nodes get synthetic deps ──────────────
// Note: RFC v4's exclusivity check rejects any case where a body node has a
// direct caller chain to the after-loop target. V19 instead verifies that
// body nodes with NO explicit path to afterA (including chained body nodes)
// all receive synthetic inbound deps.

test("V19: chained body nodes — all in closure; afterA depends on entire closure", () => {
  const dag = buildDAG(
    [loop("L"), fetch_("body1"), fetch_("body2"), fetch_("afterA")],
    [
      rel("L", "body1", "loop"),
      rel("body1", "body2", "sequential"),
      rel("L", "afterA", "after_loop"),
    ],
    "V19", ""
  );
  const afterA = dag.nodes.find(n => n.id === "node_afterA");
  // Both body1 and body2 are in closure; both must gate afterA
  assert.ok(afterA.dependencies.includes("node_body1"), "afterA must depend on body1");
  assert.ok(afterA.dependencies.includes("node_body2"), "afterA must depend on body2");
  // Synthetic edges must NOT appear in dag.edges[]
  assert.equal(dag.edges.some(e => e.isSynthetic === true), false);
});

// ─── V20: After-loop exclusivity violation ────────────────────────────────────

test("V20: reject — after-loop target reachable from body via sequential chain", () => {
  assert.throws(
    () => buildDAG(
      [loop("L"), fetch_("B"), fetch_("X"), fetch_("A")],
      [
        rel("L", "B", "loop"),
        rel("B", "X", "sequential"),
        rel("X", "A", "sequential"),
        rel("L", "A", "after_loop"),
      ],
      "V20", ""
    ),
    /after-loop target.*also reachable from the body/
  );
});

// ─── V21: isSynthetic edge tagging ────────────────────────────────────────────

test("V21: isSynthetic edges are planner-internal — absent from dag.edges[]; honored in dependencies", () => {
  const dag = buildDAG(
    [loop("L"), fetch_("bodyA"), fetch_("afterA")],
    [rel("L", "bodyA", "loop"), rel("L", "afterA", "after_loop")],
    "V21", ""
  );
  assert.equal(
    dag.edges.some(e => e.isSynthetic === true),
    false,
    "no synthetic edges in dag.edges[]"
  );
  const afterA = dag.nodes.find(n => n.id === "node_afterA");
  assert.ok(afterA.dependencies.includes("node_bodyA"), "synthetic dep honored in node.dependencies");
});

// ─── V22: Cycle-break leaves loop bodyless — both cases ───────────────────────

test("V22 case 1: intents [L,B] — DFS removes B→L back-edge; loop body preserved", () => {
  // L first → DFS visits L, descends to B via loop edge, then sees B→L (L is GRAY) = back-edge
  assert.doesNotThrow(() => buildDAG(
    [loop("L"), fetch_("B")],
    [rel("L", "B", "loop"), rel("B", "L", "sequential")],
    "V22-case1", ""
  ));
});

test("V22 case 2: intents [B,L] — DFS removes L→B back-edge (only body); validatePostCycleBreak rejects", () => {
  // B first → DFS visits B, descends to L via sequential, then sees L→B (B is GRAY) = back-edge (the loop body!)
  assert.throws(
    () => buildDAG(
      [fetch_("B"), loop("L")],
      [rel("L", "B", "loop"), rel("B", "L", "sequential")],
      "V22-case2", ""
    ),
    /cycle breaking removed the only body edge of loop/
  );
});
