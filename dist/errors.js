export class InvalidEdgeError extends Error {
    reason;
    edgeId;
    constructor(reason, edgeId) {
        super(`InvalidEdgeError: ${reason} (edge: ${edgeId})`);
        this.reason = reason;
        this.edgeId = edgeId;
        this.name = "InvalidEdgeError";
    }
}
export class InvalidLoopError extends Error {
    reason;
    loopNodeId;
    constructor(reason, loopNodeId) {
        super(`InvalidLoopError: ${reason}${loopNodeId ? ` (loop: ${loopNodeId})` : ""}`);
        this.reason = reason;
        this.loopNodeId = loopNodeId;
        this.name = "InvalidLoopError";
    }
}
export class PlannerInvariantError extends Error {
    constructor(reason) {
        super(`PlannerInvariantError: ${reason}`);
        this.name = "PlannerInvariantError";
    }
}
export class APSAuthError extends Error {
    statusCode;
    apsCode;
    constructor(message, statusCode, apsCode) {
        super(message);
        this.statusCode = statusCode;
        this.apsCode = apsCode;
        this.name = "APSAuthError";
    }
}
