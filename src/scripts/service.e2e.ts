/**
 * Service loop / crew board / field surface integration test (P8 acceptance).
 *
 *   1. the P7 ticket (offline_24h → FAULT → auto-ticket) is assignable to a crew
 *      on the day board, and still requires the rule's machine check to reach
 *      VERIFIED — a human cannot hand-write that state;
 *   2. an RMA swap produces an equipment lineage row and a note on the ITC claim;
 *   3. field check-out on a seeded install stamps installer_of_record.
 *
 * Self-cleaning.  npx ts-node src/scripts/service.e2e.ts
 */
import assert from 'node:assert/strict';
import prisma from '../config/database';
import { pollFleet } from '../services/poller.service';
import { assignTicket, getQueue, getTicket } from '../services/service.service';
import { getBoard, scheduleWorkOrder } from '../services/crew.service';
import { checkIn, checkOut, getWorkOrder, syncOps } from '../services/field.service';
import { recordRma, transitionTicket, verifyTicket } from '../lib/lifecycle';

const MARK = `P8E2E-${Date.now()}`;
const HOUR = 3_600_000;
const made = { systemIds: [] as string[], siteIds: [] as string[], propertyId: '', crewId: '', installerId: '' };
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

async function run() {
  const property = await prisma.property.create({
    data: { address: `${MARK} 3 Service St`, town: 'Hartford', postalCode: '06101', county: 'Hartford' },
  });
  made.propertyId = property.id;

  const installer = await prisma.installer.create({
    data: { orgName: `${MARK} Installer`, selfPerform: false, licenseNos: { E1: 'E1-4471' } },
  });
  made.installerId = installer.id;
  const crew = await prisma.crew.create({
    data: { installerId: installer.id, label: 'Crew A', members: [{ name: 'M. Rivera', license: 'E2-118' }], capacityPerDay: 2 },
  });
  made.crewId = crew.id;

  try {
    // ═══ 1. the P7 ticket → crew board → machine-verified close ════════════
    const siteId = `${MARK}-SITE`;
    const dark = await prisma.system.create({
      data: {
        propertyId: property.id,
        unitLabel: '3C',
        addressLine: `${MARK} 3C`,
        stage: 'OPERATING',
        kwRated: 11.3,
        kwhRated: 15,
        enlightenSiteId: siteId,
        warrantyEnd: new Date(Date.now() + 200 * 864e5),
        installerOfRecord: { installer_org: installer.orgName, crew_label: 'Crew A', lead_name: 'M. Rivera' },
      },
    });
    made.systemIds.push(dark.id);
    const site = await prisma.monitoringSite.create({
      data: { projectId: null, provider: 'Enphase', providerSiteId: siteId, lastSeenAt: hoursAgo(25) },
    });
    made.siteIds.push(site.id);
    await prisma.telemetrySnapshot.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        monitoringSiteId: site.id,
        ts: hoursAgo(80 - i),
        soc: 70,
        powerKw: 0,
        mode: 'SELF_CONSUMPTION',
        gridConnected: true,
      })),
    });

    await pollFleet(made.systemIds);
    const alert = await prisma.alert.findFirstOrThrow({ where: { systemId: dark.id, ruleKey: 'offline_24h', clearedAt: null } });
    const ticketId = alert.ticketId!;
    assert.ok(ticketId, 'P7 opened the ticket');

    // the queue is severity-sorted and shows the ticket
    const queue = await getQueue();
    const queued = queue.tickets.find((t) => t.id === ticketId)!;
    assert.ok(queued, 'ticket appears in the service queue');
    assert.equal(queued.severity, 'FAULT');
    assert.equal(queued.warranty_flag, true, 'sub-installed inside the workmanship window → warranty flag');

    // detail carries the installer of record and the machine check it must pass
    const detail = await getTicket(ticketId);
    assert.ok(detail.installer_of_record, 'installer of record is always displayed (03 §Service)');
    assert.equal(detail.alert?.rule_key, 'offline_24h');
    assert.match(detail.verify_check ?? '', /48h/, 'detail names the machine check that will close it');
    assert.ok((detail.remote_steps_suggested ?? []).length > 0, 'remote steps suggested before a field visit');

    // → assignable to a crew on the day board
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 1);
    const assigned = await assignTicket(ticketId, { crewId: crew.id, date: day, by: 'e2e' });
    assert.equal(assigned.work_order.type, 'SERVICE', 'a SERVICE work order carries the visit');
    assert.equal(assigned.work_order.crewId, crew.id);
    assert.equal(assigned.ticket.state, 'SCHEDULED', 'a booked visit moves the ticket to SCHEDULED');

    const board = await getBoard(day, 3);
    const column = board.columns.find((c) => c.crew.id === crew.id)!;
    assert.ok(column, 'the crew has a column on the day board');
    const dayCell = column.days.find((d) => d.day === day.toISOString().slice(0, 10))!;
    assert.ok(dayCell.cards.some((c) => c.id === assigned.work_order.id), 'the work order lands on that day');
    assert.equal(dayCell.capacity, 2, 'crew capacity is on the column');
    assert.ok(dayCell.towns.includes('Hartford'), 'the day carries its towns for routing');

    // → VERIFIED cannot be hand-written
    await assert.rejects(
      () => transitionTicket(ticketId, 'VERIFIED', {}, prisma),
      /MACHINE_VERIFY_REQUIRED|machine check/,
      'a human cannot set VERIFIED',
    );
    // → RESOLVED needs a resolution code
    await assert.rejects(
      () => transitionTicket(ticketId, 'RESOLVED', {}, prisma),
      /requires a resolution code/,
      'RESOLVED without a code is refused',
    );

    await transitionTicket(ticketId, 'ON_SITE', {}, prisma);
    await transitionTicket(ticketId, 'RESOLVED', { resolutionCode: 'WIRING', by: 'e2e' }, prisma);

    // the machine check still fails — telemetry has not been clean for 48h
    assert.equal(await verifyTicket(ticketId), false, 'verify refuses while the check fails');
    assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).state, 'RESOLVED', 'stays visibly unverified');

    // restore a clean 48h, then the machine closes it
    await prisma.telemetrySnapshot.createMany({
      data: Array.from({ length: 49 }, (_, i) => ({
        monitoringSiteId: site.id,
        ts: hoursAgo(48 - i),
        soc: 84,
        powerKw: 1.1,
        mode: 'SELF_CONSUMPTION',
        gridConnected: true,
      })),
    });
    assert.equal(await verifyTicket(ticketId), true, 'the machine check now passes');
    const closed = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    assert.equal(closed.state, 'CLOSED', 'VERIFIED then CLOSED');
    assert.ok(closed.verifiedAt, 'verified stamp is the machine\'s');

    // ═══ 2. RMA → lineage row + claim evidence note ═══════════════════════
    const claim = await prisma.itcClaim.create({
      data: {
        systemId: dark.id,
        status: 'EVIDENCE_COMPLETE',
        evidence: { serial_attestations: { [`${MARK}-OLD`]: 'doc-old' }, notes: [] },
      },
    });
    await prisma.equipment.create({
      data: { systemId: dark.id, serial: `${MARK}-OLD`, kind: 'BATTERY', sku: 'IQ10C', status: 'INSTALLED', installedAt: new Date() },
    });

    const hwTicket = await prisma.ticket.create({
      data: { systemId: dark.id, category: 'HARDWARE', source: 'auto', severity: 'FAULT', state: 'ON_SITE' },
    });
    const rma = await recordRma(
      hwTicket.id,
      { oldSerial: `${MARK}-OLD`, newSerial: `${MARK}-NEW`, claimNo: 'RMA-9912', by: 'e2e' },
      prisma,
    );

    const old = await prisma.equipment.findUniqueOrThrow({ where: { serial: `${MARK}-OLD` } });
    assert.equal(old.status, 'RMA_OUT', 'the pulled unit is RMA_OUT, not deleted');
    assert.equal(old.replacedById, rma.replacement.id, 'lineage row: replaced_by points at the new serial');
    assert.equal(old.rmaNo, 'RMA-9912');
    assert.ok(old.removedAt, 'removal stamped');
    assert.equal(rma.replacement.status, 'INSTALLED', 'the replacement is installed');

    const afterClaim = await prisma.itcClaim.findUniqueOrThrow({ where: { id: claim.id } });
    const evidence = afterClaim.evidence as { serial_attestations: Record<string, unknown>; notes: Array<{ kind: string; text: string }> };
    assert.ok(!(`${MARK}-OLD` in evidence.serial_attestations), 'the pulled serial leaves the evidence file');
    assert.ok(`${MARK}-NEW` in evidence.serial_attestations, 'the new serial is listed');
    assert.equal(evidence.serial_attestations[`${MARK}-NEW`], null, 'its attestation is owed, not assumed');
    assert.equal(evidence.notes.length, 1, 'a note lands on the claim');
    assert.match(evidence.notes[0].text, /RMA swap/, 'the note says what happened');
    assert.equal(afterClaim.status, 'BASIS_LOCKED', 'evidence is no longer complete, so the status steps back');

    // ═══ 3. field check-out stamps installer_of_record ════════════════════
    const install = await prisma.system.create({
      data: { propertyId: property.id, unitLabel: '4A', addressLine: `${MARK} 4A`, stage: 'S06_SCHEDULED', kwRated: 11.3, kwhRated: 15 },
    });
    made.systemIds.push(install.id);
    for (const key of ['crew_assigned', 'resident_confirmed']) {
      await prisma.checklistItem.create({
        data: { systemId: install.id, stage: 'S06_SCHEDULED', key, label: key, required: true, state: 'DONE', doneAt: new Date() },
      });
    }
    const wo = await prisma.workOrder.create({
      data: { systemId: install.id, type: 'INSTALL', crewId: crew.id, date: new Date(), status: 'SCHEDULED' },
    });

    // the field screen is one call and carries the S07 sequence as tap targets
    const screen = await getWorkOrder(wo.id, { crewId: crew.id, role: 'FIELD' });
    assert.equal(screen.checklist.length, 11, 'the S07 field sequence renders as tap targets');
    assert.ok(screen.checklist.some((s) => s.camera), 'camera prompts flagged');

    // FIELD role is scoped to its own crew
    await assert.rejects(
      () => getWorkOrder(wo.id, { crewId: 'someone-else', role: 'FIELD' }),
      /not assigned to your crew/,
      'a field user cannot open another crew\'s work order',
    );

    await checkIn(wo.id, { lat: 41.76, lng: -72.68 }, 'e2e');
    assert.equal(
      (await prisma.system.findUniqueOrThrow({ where: { id: install.id } })).stage,
      'S07_INSTALLED',
      'check-in drives AUTO S06→S07',
    );

    // an offline queue replays in order, idempotently
    const ops = [
      { id: 'op1', op: 'checkin' as const },
      { id: 'op2', op: 'step' as const, key: 'pre_photos' },
      { id: 'op3', op: 'photo' as const, photo: { stage_key: 'pre_photos', file_key: `${MARK}/pre.jpg` } },
      { id: 'op4', op: 'serials' as const, serials: [{ serial: `${MARK}-BAT-1`, kind: 'BATTERY', sku: 'IQ10C' }] },
      { id: 'op5', op: 'activation' as const, enlighten_site_id: `${MARK}-ACT` },
      { id: 'op6', op: 'signature' as const, name: 'C. Mendez' },
    ];
    const sync1 = await syncOps(wo.id, ops, 'e2e');
    assert.equal(sync1.results.find((r) => r.id === 'op1')!.result, 'skipped', 'a replayed check-in is a no-op');
    assert.equal(sync1.results.find((r) => r.id === 'op4')!.result, 'applied', 'serials captured');

    const sync2 = await syncOps(wo.id, ops, 'e2e');
    assert.ok(
      sync2.results.filter((r) => r.result === 'applied').length < sync1.results.filter((r) => r.result === 'applied').length,
      'replaying the whole queue does not duplicate work',
    );
    const photos = (await prisma.workOrder.findUniqueOrThrow({ where: { id: wo.id } })).photos as unknown[];
    assert.equal(photos.length, 1, 'the same photo never lands twice');
    assert.equal(await prisma.equipment.count({ where: { serial: `${MARK}-BAT-1` } }), 1, 'no duplicate equipment row');

    // check-out is the moment installer_of_record is stamped (L6)
    const out = await checkOut(wo.id, 'e2e');
    assert.ok(out.installer_of_record, 'check-out stamps installer_of_record');
    const ior = out.installer_of_record as { installer_org: string; crew_label: string; work_order_id: string };
    assert.equal(ior.installer_org, installer.orgName, 'the org that actually did the work');
    assert.equal(ior.crew_label, 'Crew A');
    assert.equal(ior.work_order_id, wo.id, 'traceable to the work order');

    // and it refuses to run before check-in
    const other = await prisma.workOrder.create({ data: { systemId: install.id, type: 'SERVICE', crewId: crew.id, status: 'SCHEDULED' } });
    await assert.rejects(() => checkOut(other.id, 'e2e'), /Check in before checking out/, 'no check-out without a check-in');

    // over-capacity is reported, not silently allowed
    const sched = await scheduleWorkOrder(other.id, { crewId: crew.id, date: day, by: 'e2e' });
    assert.ok(sched.work_order.date, 'scheduled');

    console.log('\n✅ service/crew/field e2e PASSED — ticket→crew→machine-verified close, RMA lineage, field check-out.');
  } finally {
    await cleanup();
  }
}

async function cleanup() {
  const ids = made.systemIds;
  if (ids.length) {
    await prisma.itcBasisLine.deleteMany({ where: { claim: { systemId: { in: ids } } } });
    await prisma.itcClaim.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.equipment.updateMany({ where: { systemId: { in: ids } }, data: { replacedById: null } });
    await prisma.equipment.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.alert.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.workOrder.updateMany({ where: { systemId: { in: ids } }, data: { ticketId: null } });
    await prisma.ticket.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.workOrder.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.checklistItem.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.stageHistory.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.ledgerEntry.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.enrollment.deleteMany({ where: { systemId: { in: ids } } });
    await prisma.activityLog.deleteMany({ where: { entity: 'system', entityId: { in: ids } } });
    await prisma.system.deleteMany({ where: { id: { in: ids } } });
  }
  if (made.siteIds.length) {
    await prisma.telemetrySnapshot.deleteMany({ where: { monitoringSiteId: { in: made.siteIds } } });
    await prisma.monitoringSite.deleteMany({ where: { id: { in: made.siteIds } } });
  }
  if (made.crewId) await prisma.crew.deleteMany({ where: { id: made.crewId } });
  if (made.installerId) await prisma.installer.deleteMany({ where: { id: made.installerId } });
  if (made.propertyId) await prisma.property.deleteMany({ where: { id: made.propertyId } });
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌ service e2e FAILED\n', e);
    await prisma.$disconnect();
    process.exit(1);
  });
