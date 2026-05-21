import { v4 as uuidv4 } from "uuid";
// ─── Helpers ──────────────────────────────────────────────────────────────
function buildNodes(intents) {
    return intents.map((intent) => ({
        id: `node_${intent.id}`,
        intentId: intent.id,
        label: intent.label,
        type: intent.type,
        description: intent.description,
        action: intent.action,
        entities: intent.entities,
        parameters: intent.parameters,
        dependencies: [], // filled after edge processing
    }));
}
function buildEdges(relationships) {
    return relationships.map((rel) => ({
        id: `${rel.from}_${rel.to}`,
        from: `node_${rel.from}`,
        to: `node_${rel.to}`,
        type: rel.type,
        condition: rel.condition,
        confidence: rel.confidence ?? 1.0,
    }));
}
// ─── Cycle detection & breaking ──────────────────────────────────────────
/**
 * Detects cycles using DFS. Returns the set of edge IDs involved in back-edges.
 */
function detectCycles(nodeIds, edges) {
    const adj = new Map();
    for (const id of nodeIds)
        adj.set(id, []);
    for (const e of edges) {
        adj.get(e.from)?.push(e);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const id of nodeIds)
        color.set(id, WHITE);
    const cycleEdgeIds = [];
    function dfs(u) {
        color.set(u, GRAY);
        for (const edge of adj.get(u) ?? []) {
            const v = edge.to;
            if (color.get(v) === GRAY) {
                // Back-edge → cycle
                cycleEdgeIds.push(edge.id);
            }
            else if (color.get(v) === WHITE) {
                dfs(v);
            }
        }
        color.set(u, BLACK);
    }
    for (const id of nodeIds) {
        if (color.get(id) === WHITE)
            dfs(id);
    }
    return { hasCycles: cycleEdgeIds.length > 0, cycleEdgeIds };
}
/**
 * Breaks cycles by removing the lowest-confidence back-edges.
 */
function breakCycles(edges, cycleEdgeIds) {
    const cycleSet = new Set(cycleEdgeIds);
    // Among cycle edges, sort by confidence ascending and remove the weakest
    const cycleEdges = edges
        .filter((e) => cycleSet.has(e.id))
        .sort((a, b) => a.confidence - b.confidence);
    // Remove the single lowest-confidence cycle edge per cycle
    const toRemove = new Set();
    for (const e of cycleEdges) {
        toRemove.add(e.id);
        // Re-check — for simplicity remove all back-edges (they're the minimal cut)
    }
    return edges.filter((e) => !toRemove.has(e.id));
}
function topologicalSort(nodeIds, edges) {
    // Build in-degree map and adjacency list
    const inDegree = new Map();
    const adj = new Map();
    for (const id of nodeIds) {
        inDegree.set(id, 0);
        adj.set(id, []);
    }
    for (const edge of edges) {
        adj.get(edge.from)?.push(edge.to);
        inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
    const queue = [];
    const levels = new Map();
    for (const [id, deg] of inDegree) {
        if (deg === 0) {
            queue.push(id);
            levels.set(id, 0);
        }
    }
    const order = [];
    while (queue.length > 0) {
        // Sort queue to make output deterministic (stable by node ID)
        queue.sort();
        const u = queue.shift();
        order.push(u);
        const uLevel = levels.get(u) ?? 0;
        for (const v of adj.get(u) ?? []) {
            const newDeg = (inDegree.get(v) ?? 1) - 1;
            inDegree.set(v, newDeg);
            // Level = max(current level of v, level of u + 1)
            const currentLevel = levels.get(v) ?? 0;
            levels.set(v, Math.max(currentLevel, uLevel + 1));
            if (newDeg === 0)
                queue.push(v);
        }
    }
    // Any remaining nodes (shouldn't happen after cycle breaking, but safety net)
    for (const id of nodeIds) {
        if (!order.includes(id)) {
            order.push(id);
            levels.set(id, (levels.get(id) ?? 0));
        }
    }
    return { order, levels };
}
// ─── Parallel group detection ────────────────────────────────────────────
/**
 * Groups nodes at the same topological level that have no direct dependency between them.
 */
function buildParallelGroups(nodeIds, levels, edges) {
    // Group by level
    const levelMap = new Map();
    for (const id of nodeIds) {
        const level = levels.get(id) ?? 0;
        if (!levelMap.has(level))
            levelMap.set(level, []);
        levelMap.get(level).push(id);
    }
    // Build direct-dependency set
    const directDeps = new Set(edges.map((e) => `${e.from}|${e.to}`));
    const groups = [];
    for (const [, group] of [...levelMap].sort((a, b) => a[0] - b[0])) {
        if (group.length < 2)
            continue;
        // Filter out pairs that have a direct edge between them
        const parallel = group.filter((id) => {
            return group.some((other) => {
                if (other === id)
                    return false;
                return (!directDeps.has(`${id}|${other}`) &&
                    !directDeps.has(`${other}|${id}`));
            });
        });
        if (parallel.length >= 2) {
            groups.push([...new Set(parallel)].sort());
        }
    }
    return groups;
}
// ─── Main export ──────────────────────────────────────────────────────────
export function buildDAG(intents, relationships, name, description) {
    const nodes = buildNodes(intents);
    let edges = buildEdges(relationships);
    const nodeIds = nodes.map((n) => n.id);
    // Cycle detection + breaking
    const { hasCycles, cycleEdgeIds } = detectCycles(nodeIds, edges);
    if (hasCycles) {
        edges = breakCycles(edges, cycleEdgeIds);
    }
    // Topological sort
    const { order: execution_order, levels } = topologicalSort(nodeIds, edges);
    // Populate dependencies on each node
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    for (const edge of edges) {
        const targetNode = nodeMap.get(edge.to);
        if (targetNode && !targetNode.dependencies.includes(edge.from)) {
            targetNode.dependencies.push(edge.from);
        }
    }
    // Parallel groups
    const parallel_groups = buildParallelGroups(nodeIds, levels, edges);
    return {
        id: uuidv4(),
        name,
        description,
        created_at: new Date().toISOString(),
        nodes,
        edges,
        execution_order,
        metadata: {
            intent_count: intents.length,
            edge_count: edges.length,
            has_cycles: hasCycles,
            parallel_groups,
        },
    };
}
