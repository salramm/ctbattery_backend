/**
 * lib/lifecycle — the state machine. One gate validator + one advance function
 * used by every caller (routes, pollers, field app). No stage logic lives outside
 * this module (02 §, P2).
 */
export * from './transitions';
export * from './errors';
export { evaluateGate, evaluateGateWith, batchContext } from './gates';
export type { GateResult, GateContext } from './gates';
export { buildLifecycleMap } from './map';
export { assertNotHeld, addBusinessDays } from './holds';
export {
  advance,
  applyChecklist,
  logDocument,
  block,
  unblock,
  terminal,
  openTurnover,
  onSnapshotWritten,
  onRofLogged,
  onCofLogged,
  onWorkOrderCheckin,
  onWorkOrderCheckout,
  onTelemetryConfirmed,
  onDermsVisible,
} from './machine';
export type { AdvanceOpts, ChecklistPatch, LogDocumentInput, TerminalInput } from './machine';
