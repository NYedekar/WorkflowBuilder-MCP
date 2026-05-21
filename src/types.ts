export type IntentType = "fetch" | "transform" | "send" | "store" | "condition" | "loop" | "trigger" | "custom";

export interface Intent {
  id: string;
  label: string;
  type: IntentType;
  description: string;
  action: string;
  entities: string[];
  parameters: Record<string, unknown>;
  raw?: string;
}

export type RelationshipType = "sequential" | "parallel" | "conditional" | "loop" | "trigger";

export interface IntentRelationship {
  from: string;
  to: string;
  type: RelationshipType;
  condition?: string;
  confidence?: number;
}

export interface WorkflowNode {
  id: string;
  intentId: string;
  label: string;
  type: IntentType;
  description: string;
  action: string;
  entities: string[];
  parameters: Record<string, unknown>;
  dependencies: string[];  // node ids this depends on
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  type: RelationshipType;
  condition?: string;
  confidence: number;
}

export interface WorkflowDAG {
  id: string;
  name: string;
  description: string;
  created_at: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  execution_order: string[];  // topological sort of node ids
  metadata: {
    intent_count: number;
    edge_count: number;
    has_cycles: boolean;
    parallel_groups: string[][];
  };
}
