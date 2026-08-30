/**
 * Pipeline board data (03 §Pipeline, 05-UI-DELTA D1/D2). Reads `systems` — never
 * the frozen four-table spine and never /api/ops/* (R7).
 *
 * Lens routing (L5): the delivery board is `terminal_state IS NULL AND stage
 * S01–S08`; S09/OPERATING belong to Fleet. The S09 column is returned so the
 * board can render its explainer, but it never carries cards.
 *
 * Every card ships its own `unmet` list so the drop handler can render the
 * server's verdict — the board never computes a gate itself (§4 shim #1).
 */
import type { Prisma, Stage, System } from '@prisma/client';
import prisma from '../config/database';
import { STAGE_ORDER, batchContext, evaluateGateWith, shortCode, stageLabel } from '../lib/lifecycle';
import type { Unmet } from '../lib/lifecycle';

/** Stages the delivery board owns. S09 renders as an explainer column only. */
const BOARD_STAGES: Stage[] = STAGE_ORDER.slice(0, 8) as Stage[];
const S09: Stage = 'S09_LIVE';

/** The four S08 proofs behind the card's micro-tracker (03 §Pipeline). */
const S08_DOTS: Array<{ key: string; label: string }> = [
  { key: 'inspection_passed', label: 'INSP' },
  { key: 'pto_received', label: 'PTO' },
  { key: 'derms_visible', label: 'DERMS' },
  { key: 'cgb_pkg_accepted', label: 'PKG' },
];

export interface BoardFilters {
  propertyId?: string;
  tier?: string;
  town?: string;
  installer?: string;
  blockedOnly?: boolean;
}

export interface BoardCard {
  id: string;
  address_line: string | null;
  unit_label: string | null;
  property: { id: string; name: string | null; town: string | null } | null;
  source: string | null;
  pills: string[];
  days_in_stage: number | null;
  blocked_code: string | null;
  blocked_note: string | null;
  unmet: Unmet[];
  installer: string | null;
  s08_dots: Array<{ key: string; label: string; done: boolean }> | null;
}

/** Tier/geo pills exactly as the mock renders them: LI · UND · GE · EC. */
function pillsFor(system: System, ecAdder: boolean): string[] {
  const pills: string[] = [];
  if (system.tier === 'LI') pills.push('LI');
  if (system.tier === 'UNDERSERVED') pills.push('UND');
  if (system.gridEdge) pills.push('GE');
  if (ecAdder) pills.push('EC');
  return pills;
}

function installerName(system: System): string | null {
  const ior = system.installerOfRecord as { installer_org?: string | null } | null;
  return ior?.installer_org ?? null;
}

/** days_in_stage from the v_stage_age view (01 §Derived — never stored twice). */
async function daysInStage(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  // Select only the numeric column — the view's `age_interval` has no Prisma type.
  const rows = await prisma.$queryRaw<Array<{ system_id: string; days: number | null }>>`
    SELECT system_id, days_in_stage::float8 AS days
    FROM v_stage_age
    WHERE system_id = ANY(${ids}::uuid[])
  `;
  const out = new Map<string, number>();
  for (const r of rows) if (r.days != null) out.set(r.system_id, Math.floor(Number(r.days)));
  return out;
}

/** Energy-community adder per system, read off the current qualification snapshot. */
async function ecAdders(systems: System[]): Promise<Set<string>> {
  const snapIds = systems.map((s) => s.currentSnapshotId).filter((v): v is string => Boolean(v));
  if (snapIds.length === 0) return new Set();
  const snaps = await prisma.qualSnapshot.findMany({
    where: { id: { in: snapIds } },
    select: { id: true, systemId: true, itcProfile: true },
  });
  const out = new Set<string>();
  for (const s of snaps) {
    const profile = s.itcProfile as { ec?: number } | null;
    if ((profile?.ec ?? 0) > 0) out.add(s.systemId);
  }
  return out;
}

async function s08Dots(ids: string[]): Promise<Map<string, Array<{ key: string; label: string; done: boolean }>>> {
  const out = new Map<string, Array<{ key: string; label: string; done: boolean }>>();
  if (ids.length === 0) return out;
  const items = await prisma.checklistItem.findMany({
    where: { systemId: { in: ids }, stage: 'S08_COMMISSIONED', key: { in: S08_DOTS.map((d) => d.key) } },
    select: { systemId: true, key: true, state: true },
  });
  const done = new Set(items.filter((i) => i.state === 'DONE').map((i) => `${i.systemId}:${i.key}`));
  for (const id of ids) {
    out.set(id, S08_DOTS.map((d) => ({ ...d, done: done.has(`${id}:${d.key}`) })));
  }
  return out;
}

/**
 * The delivery board: nine columns, cards grouped by stage, each carrying the
 * server's gate verdict.
 */
export async function getBoard(filters: BoardFilters = {}) {
  const where: Prisma.SystemWhereInput = {
    terminalState: null,
    stage: { in: BOARD_STAGES },
    ...(filters.propertyId ? { propertyId: filters.propertyId } : {}),
    ...(filters.tier ? { tier: filters.tier as System['tier'] } : {}),
    ...(filters.blockedOnly ? { blockedCode: { not: null } } : {}),
    ...(filters.town ? { property: { town: { equals: filters.town, mode: 'insensitive' } } } : {}),
  };

  const systems = await prisma.system.findMany({
    where,
    include: { property: { select: { id: true, name: true, town: true } } },
    orderBy: [{ stage: 'asc' }, { createdAt: 'asc' }],
  });

  // Installer filter is a JSON snapshot, not a column — filter in memory.
  const filtered = filters.installer
    ? systems.filter((s) => (installerName(s) ?? '').toLowerCase().includes(filters.installer!.toLowerCase()))
    : systems;

  const ids = filtered.map((s) => s.id);
  const [ages, ec, dots, ctx] = await Promise.all([
    daysInStage(ids),
    ecAdders(filtered),
    s08Dots(filtered.filter((s) => s.stage === 'S08_COMMISSIONED').map((s) => s.id)),
    batchContext(filtered),
  ]);

  const cards = new Map<Stage, BoardCard[]>();
  for (const stage of [...BOARD_STAGES, S09]) cards.set(stage, []);

  for (const s of filtered) {
    const gate = await evaluateGateWith(ctx, s);
    const card: BoardCard = {
      id: s.id,
      address_line: s.addressLine,
      unit_label: s.unitLabel,
      property: s.property ? { id: s.property.id, name: s.property.name, town: s.property.town } : null,
      source: s.source,
      pills: pillsFor(s, ec.has(s.id)),
      days_in_stage: ages.get(s.id) ?? null,
      blocked_code: s.blockedCode,
      blocked_note: s.blockedNote,
      unmet: gate.unmet,
      installer: installerName(s),
      s08_dots: s.stage === 'S08_COMMISSIONED' ? dots.get(s.id) ?? null : null,
    };
    cards.get(s.stage)!.push(card);
  }

  const columns = [...BOARD_STAGES, S09].map((stage) => ({
    stage,
    code: shortCode(stage),
    label: stageLabel(stage),
    // S09 is momentary — the COF write chains straight through it (02 §Transitions).
    momentary: stage === S09,
    count: cards.get(stage)!.length,
    cards: cards.get(stage)!,
  }));

  return {
    lens: 'delivery',
    columns,
    totals: {
      systems: filtered.length,
      blocked: filtered.filter((s) => s.blockedCode).length,
    },
  };
}

/** Filter options for the board's four selects, derived from what is on the board. */
export async function getBoardFilters() {
  const systems = await prisma.system.findMany({
    where: { terminalState: null, stage: { in: BOARD_STAGES } },
    select: {
      tier: true,
      installerOfRecord: true,
      property: { select: { id: true, name: true, town: true } },
    },
  });

  const properties = new Map<string, { id: string; label: string }>();
  const towns = new Set<string>();
  const tiers = new Set<string>();
  const installers = new Set<string>();

  for (const s of systems) {
    if (s.property) {
      properties.set(s.property.id, { id: s.property.id, label: s.property.name ?? s.property.town ?? s.property.id });
      if (s.property.town) towns.add(s.property.town);
    }
    if (s.tier) tiers.add(s.tier);
    const org = (s.installerOfRecord as { installer_org?: string | null } | null)?.installer_org;
    if (org) installers.add(org);
  }

  return {
    properties: [...properties.values()].sort((a, b) => a.label.localeCompare(b.label)),
    towns: [...towns].sort(),
    tiers: [...tiers].sort(),
    installers: [...installers].sort(),
  };
}
