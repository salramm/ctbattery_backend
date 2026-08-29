/**
 * Lifecycle backfill — qual_snapshots v1 (P1 step 5, R4).
 *
 * Every migrated system at ≥ S02 gets a versioned qualification snapshot written
 * by the EXISTING ESS qualify engine (`qualifyEss`) — only its I/O is adapted
 * here; the lookups are not rewritten. Sets `systems.current_snapshot_id`, `tier`,
 * and `grid_edge`. This satisfies the S01 gate (`current_snapshot_id IS NOT NULL`)
 * for every already-qualified system and R4 for Application-derived systems.
 *
 * Idempotent: a system that already carries `current_snapshot_id` is skipped.
 * Run AFTER the migration + seed:
 *   npx ts-node src/scripts/backfill-lifecycle.ts
 */
import prisma from '../config/database';
import { qualifyEss } from '../services/ess.service';
import { Prisma } from '@prisma/client';
import type { Tier } from '@prisma/client';

// Stages at or beyond S02 (S01 has no snapshot; its gate is that one gets written).
const AT_OR_ABOVE_S02 = [
  'S02_QUALIFIED', 'S03_COMMITTED', 'S04_APPLIED', 'S05_ENTITLED',
  'S06_SCHEDULED', 'S07_INSTALLED', 'S08_COMMISSIONED', 'S09_LIVE', 'OPERATING',
] as const;

function mapTier(key: string | null | undefined): Tier {
  if (key === 'LOW_INCOME') return 'LI';
  if (key === 'UNDERSERVED') return 'UNDERSERVED';
  return 'STANDARD';
}

async function main() {
  const systems = await prisma.system.findMany({
    where: { stage: { in: AT_OR_ABOVE_S02 as unknown as string[] as never }, currentSnapshotId: null },
    include: { property: { select: { address: true, town: true, lat: true, lng: true } } },
  });

  console.log(`Backfilling qual_snapshots for ${systems.length} systems at ≥ S02…`);
  let ok = 0;
  let fallback = 0;

  for (const s of systems) {
    const p = s.property;
    let tier: Tier = 'STANDARD';
    let inputs: Record<string, unknown> = { address: p.address, town: p.town, lat: p.lat, lng: p.lng, via: 'backfill' };
    let itcProfile: Record<string, unknown> | null = null;
    let revenue: Record<string, unknown> | null = null;
    let gridEdge = s.gridEdge ?? false;

    try {
      const q = await qualifyEss({
        lat: p.lat ?? undefined,
        lng: p.lng ?? undefined,
        address: p.address ?? undefined,
        town: p.town ?? undefined,
      });
      if (q.located) {
        tier = mapTier(q.tier);
        itcProfile = {
          base: q.itc?.basePct ?? null,
          confirmedPct: q.itc?.confirmedPct ?? null,
          potentialPct: q.itc?.potentialPct ?? null,
          adders: q.itc?.adders ?? [],
        };
        revenue = { compensation: q.compensation, reasons: q.reasons };
        gridEdge = q.compensation?.gridEdge === 'likely';
        inputs = { ...inputs, coordinates: q.coordinates, resolvedAddress: q.address };
        ok += 1;
      } else {
        inputs = { ...inputs, note: 'ess-not-located', dataStatus: q.dataStatus };
        fallback += 1;
      }
    } catch (e) {
      inputs = { ...inputs, note: 'ess-error', error: (e as Error).message };
      fallback += 1;
    }

    const snap = await prisma.qualSnapshot.create({
      data: {
        systemId: s.id,
        version: 1,
        inputs: inputs as Prisma.InputJsonObject,
        tier,
        itcProfile: (itcProfile ?? undefined) as Prisma.InputJsonObject | undefined,
        revenueProjection: (revenue ?? undefined) as Prisma.InputJsonObject | undefined,
      },
    });
    await prisma.system.update({
      where: { id: s.id },
      data: { currentSnapshotId: snap.id, tier, gridEdge },
    });
  }

  console.log(`qual_snapshots written: ${ok} located, ${fallback} fallback (tier=STANDARD).`);
  const withSnap = await prisma.system.count({ where: { currentSnapshotId: { not: null } } });
  console.log(`systems with current_snapshot_id: ${withSnap}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
