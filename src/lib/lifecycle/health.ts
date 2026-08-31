/**
 * Health cache (01 §Derived — health).
 *
 * Alerts are the truth; `systems.health` is a cache recomputed on any alert
 * open/clear or work-order state change. The precedence is fixed:
 *   FAULT (any open FAULT alert)
 *     → SERVICE (an open SERVICE work order is scheduled)
 *       → WATCH (any open WATCH alert)
 *         → OK
 *
 * Health is null before Live (01 §systems), so pre-Live systems are left alone
 * rather than being written OK — "no condition yet" is not "healthy".
 */
import type { HealthState, Prisma, Stage } from '@prisma/client';
import prisma from '../../config/database';

type Client = Prisma.TransactionClient | typeof prisma;

const LIVE_STAGES: Stage[] = ['S09_LIVE', 'OPERATING'];

/** Work-order states that mean a truck is booked but the job isn't done. */
const OPEN_WO_STATES = ['DRAFT', 'SCHEDULED', 'CHECKED_IN'] as const;

export async function computeHealth(systemId: string, client: Client = prisma): Promise<HealthState> {
  const [faults, serviceWo, watches] = await Promise.all([
    client.alert.count({ where: { systemId, clearedAt: null, severity: 'FAULT' } }),
    client.workOrder.count({ where: { systemId, type: 'SERVICE', status: { in: [...OPEN_WO_STATES] } } }),
    client.alert.count({ where: { systemId, clearedAt: null, severity: 'WATCH' } }),
  ]);

  if (faults > 0) return 'FAULT';
  if (serviceWo > 0) return 'SERVICE';
  if (watches > 0) return 'WATCH';
  return 'OK';
}

/**
 * Recompute and persist. Returns the new value, or null when the system is not
 * yet Live (health stays null until then).
 */
export async function recomputeHealth(systemId: string, client: Client = prisma): Promise<HealthState | null> {
  const system = await client.system.findUnique({ where: { id: systemId }, select: { stage: true, health: true } });
  if (!system) return null;
  if (!LIVE_STAGES.includes(system.stage)) return null;

  const health = await computeHealth(systemId, client);
  if (health !== system.health) {
    await client.system.update({ where: { id: systemId }, data: { health } });
    await client.activityLog.create({
      data: {
        entity: 'system',
        entityId: systemId,
        action: 'health',
        actor: 'system',
        meta: { from: system.health, to: health } as Prisma.InputJsonValue,
      },
    });
  }
  return health;
}
