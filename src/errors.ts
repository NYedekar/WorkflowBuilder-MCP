export class InvalidEdgeError extends Error {
  constructor(
    public readonly reason: string,
    public readonly edgeId: string
  ) {
    super(`InvalidEdgeError: ${reason} (edge: ${edgeId})`);
    this.name = "InvalidEdgeError";
  }
}

export class InvalidLoopError extends Error {
  constructor(
    public readonly reason: string,
    public readonly loopNodeId?: string
  ) {
    super(`InvalidLoopError: ${reason}${loopNodeId ? ` (loop: ${loopNodeId})` : ""}`);
    this.name = "InvalidLoopError";
  }
}

export class PlannerInvariantError extends Error {
  constructor(reason: string) {
    super(`PlannerInvariantError: ${reason}`);
    this.name = "PlannerInvariantError";
  }
}

export class APSAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly apsCode?: string
  ) {
    super(message);
    this.name = "APSAuthError";
  }
}
