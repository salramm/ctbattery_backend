/**
 * Typed lifecycle errors. The engine throws these; the thin route layer maps
 * `status`/`code`/`payload` straight onto the standard error envelope so stage
 * logic never touches req/res.
 */

export interface Unmet {
  key: string;
  label: string;
  owner_role: string | null;
}

export class LifecycleError extends Error {
  status: number;
  code: string;
  /** Extra fields merged into the response body (e.g. { gate, unmet } or { clawback_amount }). */
  payload?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, payload?: Record<string, unknown>) {
    super(message);
    this.name = 'LifecycleError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

/** 422 with the verbatim unmet-list shape (02 §Endpoints). */
export class GateError extends LifecycleError {
  constructor(gate: string, unmet: Unmet[]) {
    super(422, 'GATE_UNMET', `Gate ${gate} not satisfied`, { gate, unmet });
  }
}
