/**
 * Task holds (02 §Transitions S03→S04, §Automations). A held item is instantiated
 * and visible but cannot be completed until its clock closes — distinct from a
 * gate (which blocks a stage) and from a block code (which freezes the system).
 *
 * The only hold today: `cgb_app_submitted` waits out the 3-business-day ESA
 * cancellation window. Its length comes from the `esa_cancellation` clocks seed
 * row, so the seed stays the single source of truth (05-UI-DELTA §4 shim #4).
 */
import type { Prisma } from '@prisma/client';
import { LifecycleError } from './errors';

type Tx = Prisma.TransactionClient;

interface Hold {
  /** clocks.key supplying the window length. */
  clock: string;
  /** checklist item whose done_at starts the clock (clocks.starts_on). */
  startsOnKey: string;
  /** Fallback length if the seed row is missing. */
  defaultDays: number;
}

const HOLDS: Record<string, Hold> = {
  cgb_app_submitted: { clock: 'esa_cancellation', startsOnKey: 'esa_signed', defaultDays: 3 },
};

/** Business days: skip Saturday and Sunday (the CT ESS window is stated in business days). */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return d;
}

/**
 * Refuse a DONE write on a held item until its window closes. Throws 409
 * `TASK_HELD` carrying `held_until` so the UI can render the countdown.
 */
export async function assertNotHeld(tx: Tx, systemId: string, key: string): Promise<void> {
  const hold = HOLDS[key];
  if (!hold) return;

  const starter = await tx.checklistItem.findFirst({
    where: { systemId, key: hold.startsOnKey, state: 'DONE' },
  });
  if (!starter?.doneAt) {
    throw new LifecycleError(
      409,
      'TASK_HELD',
      `${key} is held until ${hold.startsOnKey} is signed and the ${hold.clock} window closes`,
      { clock: hold.clock, starts_on: hold.startsOnKey, held_until: null },
    );
  }

  const clock = await tx.clock.findUnique({ where: { key: hold.clock } });
  const heldUntil = addBusinessDays(starter.doneAt, clock?.lengthDays ?? hold.defaultDays);
  if (new Date() < heldUntil) {
    throw new LifecycleError(409, 'TASK_HELD', `${key} is held until the ${hold.clock} window closes`, {
      clock: hold.clock,
      starts_on: hold.startsOnKey,
      held_until: heldUntil.toISOString(),
    });
  }
}
