/**
 * Deals sub-tab (03 §Pipeline — "a list with state chips, not a kanban").
 * Accounts carry the D1–D7 deal state; the units they have released into
 * delivery are counted off `systems`, so the release column is the same
 * arithmetic the Property page shows, rolled up to the account.
 */
import prisma from '../config/database';
import { STAGE_ORDER } from '../lib/lifecycle';

const APPLIED_IDX = STAGE_ORDER.indexOf('S04_APPLIED');
const LIVE_IDX = STAGE_ORDER.indexOf('S09_LIVE');
const COMMITTED_IDX = STAGE_ORDER.indexOf('S03_COMMITTED');

export async function listDeals() {
  const accounts = await prisma.account.findMany({
    orderBy: [{ dealState: 'desc' }, { name: 'asc' }],
    include: {
      contacts: { select: { id: true, name: true, role: true } },
      properties: {
        select: {
          id: true,
          name: true,
          town: true,
          systems: {
            where: { terminalState: null },
            select: { id: true, stage: true, blockedCode: true },
          },
        },
      },
    },
  });

  // ESA-signed counts across every unit these accounts own.
  const systemIds = accounts.flatMap((a) => a.properties.flatMap((p) => p.systems.map((s) => s.id)));
  const esaDone = systemIds.length
    ? await prisma.checklistItem.findMany({
        where: { systemId: { in: systemIds }, key: 'esa_signed', state: 'DONE' },
        select: { systemId: true },
      })
    : [];
  const esaSet = new Set(esaDone.map((e) => e.systemId));

  return accounts.map((a) => {
    const systems = a.properties.flatMap((p) => p.systems);
    const idx = (stage: string) => STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      deal_state: a.dealState,
      notes: a.notes,
      properties: a.properties.map((p) => ({ id: p.id, name: p.name, town: p.town, units: p.systems.length })),
      units: systems.length,
      release: {
        esas_signed: systems.filter((s) => esaSet.has(s.id)).length,
        committed: systems.filter((s) => idx(s.stage) >= COMMITTED_IDX).length,
        applied: systems.filter((s) => idx(s.stage) >= APPLIED_IDX).length,
        live: systems.filter((s) => idx(s.stage) >= LIVE_IDX).length,
        blocked: systems.filter((s) => s.blockedCode != null).length,
      },
      contacts: a.contacts,
    };
  });
}
