/**
 * Conditional checklist predicates (01 §Seed — the `conditional` column).
 * Evaluated ONCE at stage entry; a false predicate instantiates the item as
 * `NA` so it never counts toward the gate (02 §Gate predicates note).
 */
import type { System, Property } from '@prisma/client';

export interface ConditionalContext {
  system: System;
  property: Property | null;
}

type Predicate = (ctx: ConditionalContext) => boolean;

const PREDICATES: Record<string, Predicate> = {
  // Multi-family affordable housing: a unit within a portfolio property. Master
  // agreement then governs the resident set (02 §On-enter S03).
  property_is_mfah: ({ system, property }) =>
    system.unitLabel != null || property?.accountId != null,

  // M4/M5 collar swaps that require the EDC to pull the meter. M1 (default) does not.
  collar_requires_edc_pull: ({ system }) =>
    system.connectionMethod === 'M4' || system.connectionMethod === 'M5',

  // Authority-having-jurisdiction opted into a physical inspection (else self-inspection only).
  ahj_opted: ({ property }) =>
    Boolean((property?.geo as { ahj_opted?: boolean } | null | undefined)?.ahj_opted),
};

/** True → item is active (OPEN); false → instantiated NA and excluded from the gate. */
export function evalConditional(name: string | null | undefined, ctx: ConditionalContext): boolean {
  if (!name) return true;
  const p = PREDICATES[name];
  if (!p) return true; // unknown predicate → treat as active (fail-safe: item counts)
  return p(ctx);
}
