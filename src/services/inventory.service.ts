/**
 * Inventory rail widget (05-UI-DELTA D4). One `equipment` table serves stock and
 * installed units — a status column, never a parallel inventory table (L1).
 *
 * Counting rules, so the widget and a direct query always agree:
 *   available = IN_STOCK · allocated = ALLOCATED (reserved by the S05
 *   `equipment_allocated` gate) · on_hand = available + allocated.
 * INSTALLED / RMA_OUT / RETIRED are not on hand.
 *
 * `buildable` is the honest constraint: how many complete systems the shelf can
 * produce = min over SKUs of floor(available / qty_per_system).
 */
import type { EquipKind } from '@prisma/client';
import prisma from '../config/database';

/** The bill of materials for one system (D4). */
export const BOM: Array<{ sku: string; kind: EquipKind; label: string; qty_per_system: number }> = [
  { sku: 'IQ10C', kind: 'BATTERY', label: 'IQ Battery 10C DOM', qty_per_system: 3 },
  { sku: 'X-COMBINE', kind: 'COMBINER', label: 'IQ Combiner 6C', qty_per_system: 1 },
  { sku: 'X-COLLAR', kind: 'COLLAR', label: 'IQ Meter Collar', qty_per_system: 1 },
  { sku: 'CELL-KIT', kind: 'GATEWAY', label: 'Cellular kit', qty_per_system: 1 },
];

/** Backfilled rows carry `kind` but no `sku`; fold them into that kind's SKU. */
const KIND_TO_SKU = new Map<EquipKind, string>(BOM.map((b) => [b.kind, b.sku]));

function skuOf(row: { sku: string | null; kind: EquipKind }): string | null {
  return row.sku ?? KIND_TO_SKU.get(row.kind) ?? null;
}

export async function getInventorySummary() {
  const rows = await prisma.equipment.findMany({
    where: { status: { in: ['IN_STOCK', 'ALLOCATED'] } },
    select: { sku: true, kind: true, status: true },
  });

  const skus = BOM.map((item) => {
    const mine = rows.filter((r) => skuOf(r) === item.sku);
    const available = mine.filter((r) => r.status === 'IN_STOCK').length;
    const allocated = mine.filter((r) => r.status === 'ALLOCATED').length;
    return {
      ...item,
      available,
      allocated,
      on_hand: available + allocated,
      buildable_from_this: Math.floor(available / item.qty_per_system),
    };
  });

  const buildable = skus.length ? Math.min(...skus.map((s) => s.buildable_from_this)) : 0;
  // The SKU that pins `buildable` — rendered amber in the rail.
  const constraint = skus.reduce((low, s) => (s.buildable_from_this < low.buildable_from_this ? s : low), skus[0]);

  const nextPo = await prisma.purchaseOrder.findFirst({
    where: { status: { in: ['ORDERED', 'PARTIAL'] } },
    orderBy: [{ dueAt: 'asc' }],
  });
  const poLines = (nextPo?.lines as Array<{ sku?: string; qty?: number; kind?: string }> | null) ?? [];

  const allocatedBatteries = skus.find((s) => s.kind === 'BATTERY')?.allocated ?? 0;

  return {
    skus: skus.map(({ buildable_from_this: _drop, ...s }) => s),
    buildable,
    constraint_sku: constraint ? constraint.sku : null,
    allocated_note: `${allocatedBatteries} batteries allocated to S05+ units`,
    next_po: nextPo
      ? {
          po_no: nextPo.poNo,
          vendor: nextPo.vendor,
          due_at: nextPo.dueAt,
          status: nextPo.status,
          qty: poLines.reduce((n, l) => n + (l.qty ?? 0), 0),
          lines: poLines,
        }
      : null,
  };
}
