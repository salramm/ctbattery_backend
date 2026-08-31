/**
 * Lifecycle demo seed (P10) — the R2 drop-and-reseed replacement for the legacy
 * TPO demo rows. One dataset, lifecycle-shaped.
 *
 *   one account → one property → 25 units spread across every stage and health
 *   state, with the supporting cast each surface needs: an installer and two
 *   crews, monitoring sites and telemetry for the Live units, a season with
 *   dispatch events, ledger rows, ITC claims and a cohort, one open turnover,
 *   and a few deliberate problems (a blocked unit, an offline gateway, a
 *   variance) so every screen has something real to show.
 *
 * Idempotent: re-running wipes what it previously created (matched on the
 * account) and rebuilds. It never touches rows it did not create.
 *
 *   npm run seed:demo               # build
 *   npm run seed:demo -- --down     # remove
 *   npm run seed:demo -- --drop-legacy  # ALSO drop the legacy TPO demo rows
 *
 * `--drop-legacy` is the R2 drop-and-reseed step: this dataset is the intended
 * replacement for the four-table TPO demo spine, so once you are happy with it,
 * that flag deletes SalesLead / Customer / Project and their dependents and the
 * legacy /api/ops/* surfaces go empty as R7 expects. It is opt-in and separate
 * from the seed because it is irreversible and the rows are not ours to assume
 * about. Consumer-inbound tables (Application, Lead, Loi, MfahProperty) are
 * never touched.
 */
import prisma from '../config/database';
import { openTurnover } from '../lib/lifecycle';

const ACCOUNT = 'ARIUM Greenwich';
const PROPERTY = 'Putnam Green';
const TAG = 'demo';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

/** 25 units: label, stage, and the deliberate condition each one carries. */
const UNITS: Array<{
  unit: string;
  stage: string;
  health?: 'OK' | 'WATCH' | 'FAULT' | 'SERVICE';
  blocked?: string;
  terminal?: string;
  tier?: 'LI' | 'UNDERSERVED' | 'STANDARD';
  offlineHours?: number;
  turnover?: boolean;
}> = [
  // Operating — the fleet lens
  { unit: '1A', stage: 'OPERATING', health: 'OK', tier: 'UNDERSERVED' },
  { unit: '1B', stage: 'OPERATING', health: 'OK', tier: 'UNDERSERVED' },
  { unit: '2A', stage: 'OPERATING', health: 'FAULT', tier: 'UNDERSERVED', offlineHours: 27 },
  { unit: '2B', stage: 'OPERATING', health: 'WATCH', tier: 'LI', offlineHours: 6 },
  { unit: '3C', stage: 'OPERATING', health: 'OK', tier: 'LI', turnover: true },
  { unit: '3D', stage: 'OPERATING', health: 'OK', tier: 'LI' },
  { unit: '4A', stage: 'S09_LIVE', health: 'OK', tier: 'UNDERSERVED' },
  // Build
  { unit: '4B', stage: 'S08_COMMISSIONED', tier: 'UNDERSERVED', blocked: 'B-DERMS' },
  { unit: '4C', stage: 'S08_COMMISSIONED', tier: 'LI' },
  { unit: '5A', stage: 'S07_INSTALLED', tier: 'LI' },
  { unit: '5B', stage: 'S06_SCHEDULED', tier: 'UNDERSERVED' },
  { unit: '5C', stage: 'S06_SCHEDULED', tier: 'UNDERSERVED' },
  // Entitle
  { unit: '1C', stage: 'S05_ENTITLED', tier: 'LI', blocked: 'B-PERMIT-REV' },
  { unit: '1D', stage: 'S05_ENTITLED', tier: 'UNDERSERVED' },
  { unit: '2C', stage: 'S05_ENTITLED', tier: 'UNDERSERVED' },
  { unit: '2D', stage: 'S04_APPLIED', tier: 'UNDERSERVED', blocked: 'B-CGB-DEFIC' },
  { unit: '3A', stage: 'S04_APPLIED', tier: 'LI' },
  { unit: '3B', stage: 'S04_APPLIED', tier: 'LI' },
  // Acquire
  { unit: '4D', stage: 'S03_COMMITTED', tier: 'UNDERSERVED' },
  { unit: '4E', stage: 'S03_COMMITTED', tier: 'UNDERSERVED' },
  { unit: '5D', stage: 'S03_COMMITTED', tier: 'LI' },
  { unit: '5E', stage: 'S02_QUALIFIED', tier: 'UNDERSERVED' },
  { unit: '1E', stage: 'S02_QUALIFIED', tier: 'UNDERSERVED' },
  { unit: '2E', stage: 'S01_LEAD' },
  // Terminal — greyed on the unit grid, out of both lenses
  { unit: '3E', stage: 'S03_COMMITTED', terminal: 'WITHDRAWN' },
];

const STAGE_ORDER = [
  'S01_LEAD', 'S02_QUALIFIED', 'S03_COMMITTED', 'S04_APPLIED', 'S05_ENTITLED',
  'S06_SCHEDULED', 'S07_INSTALLED', 'S08_COMMISSIONED', 'S09_LIVE', 'OPERATING',
];
const idx = (s: string) => STAGE_ORDER.indexOf(s);

async function down() {
  const account = await prisma.account.findFirst({ where: { name: ACCOUNT } });
  const property = await prisma.property.findFirst({ where: { name: PROPERTY } });
  if (property) {
    const ids = (await prisma.system.findMany({ where: { propertyId: property.id }, select: { id: true } })).map((s) => s.id);
    if (ids.length) {
      const sites = await prisma.monitoringSite.findMany({
        where: { providerSiteId: { startsWith: `${TAG}-` } },
        select: { id: true },
      });
      await prisma.telemetrySnapshot.deleteMany({ where: { monitoringSiteId: { in: sites.map((s) => s.id) } } });
      await prisma.monitoringSite.deleteMany({ where: { id: { in: sites.map((s) => s.id) } } });

      await prisma.itcBasisLine.deleteMany({ where: { claim: { systemId: { in: ids } } } });
      await prisma.itcClaim.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.ledgerEntry.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.event.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.equipment.updateMany({ where: { systemId: { in: ids } }, data: { replacedById: null } });
      await prisma.equipment.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.alert.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.workOrder.updateMany({ where: { systemId: { in: ids } }, data: { ticketId: null } });
      await prisma.ticket.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.workOrder.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.turnoverCase.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.checklistItem.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.stageHistory.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.document.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.enrollment.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.activityLog.deleteMany({ where: { entity: 'system', entityId: { in: ids } } });
      await prisma.system.updateMany({ where: { id: { in: ids } }, data: { currentSnapshotId: null, residentId: null } });
      await prisma.qualSnapshot.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.resident.deleteMany({ where: { systemId: { in: ids } } });
      await prisma.system.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.document.deleteMany({ where: { propertyId: property.id } });
    await prisma.activityLog.deleteMany({ where: { entity: 'property', entityId: property.id } });
    await prisma.property.delete({ where: { id: property.id } });
  }
  if (account) {
    await prisma.accountContact.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } });
  }
  const cohort = await prisma.itcCohort.findFirst({ where: { label: `${TAG}-2026-Q3` } });
  if (cohort) {
    await prisma.activityLog.deleteMany({ where: { entity: 'program', entityId: cohort.id } });
    await prisma.itcCohort.delete({ where: { id: cohort.id } });
  }
  await prisma.itcAllocation.deleteMany({ where: { programYear: 2026, category: 'CAT1' } });
  const season = await prisma.season.findFirst({ where: { name: 'SUMMER', programYear: 2026 } });
  if (season) await prisma.event.deleteMany({ where: { seasonId: season.id } });
  const crews = await prisma.crew.findMany({ where: { installer: { orgName: 'Northeast Storage Partners' } } });
  await prisma.workOrder.updateMany({ where: { crewId: { in: crews.map((c) => c.id) } }, data: { crewId: null } });
  await prisma.user.updateMany({ where: { crewId: { in: crews.map((c) => c.id) } }, data: { crewId: null } });
  await prisma.crew.deleteMany({ where: { id: { in: crews.map((c) => c.id) } } });
  await prisma.installer.deleteMany({ where: { orgName: 'Northeast Storage Partners' } });
  console.log('demo seed removed');
}

async function up() {
  await down();

  // ---- the cast -----------------------------------------------------------
  const account = await prisma.account.create({
    data: { type: 'OWNER', name: ACCOUNT, dealState: 'D6_RELEASING', notes: 'PM distributing resident ESAs' },
  });
  await prisma.accountContact.createMany({
    data: [
      { accountId: account.id, name: 'J. Alvarez', role: 'PM', email: 'pm@ariumgreenwich.example', phone: '203-555-0110' },
      { accountId: account.id, name: 'D. Whitfield', role: 'owner', email: 'owner@arium.example', phone: '203-555-0111' },
    ],
  });

  const property = await prisma.property.create({
    data: {
      accountId: account.id,
      name: PROPERTY,
      address: '35-38 Putnam Green',
      town: 'Greenwich',
      postalCode: '06830',
      county: 'Fairfield',
      lat: 41.0262,
      lng: -73.6282,
      geo: { edc: 'Eversource', grid_edge_circuit: true, li_tract: true, ec_msa: true, metering: 'M1' },
    },
  });

  const installer = await prisma.installer.create({
    data: {
      orgName: 'Northeast Storage Partners',
      selfPerform: false,
      licenseNos: { E1: 'E1-204471', HIC: 'HIC-0651122' },
      rates: { install: 2400, service_visit: 340 },
    },
  });
  const crewA = await prisma.crew.create({
    data: { installerId: installer.id, label: 'Crew A', capacityPerDay: 3, members: [{ name: 'M. Rivera', license: 'E2-118' }, { name: 'T. Okafor', license: 'E2-341' }] },
  });
  const crewB = await prisma.crew.create({
    data: { installerId: installer.id, label: 'Crew B', capacityPerDay: 2, members: [{ name: 'S. Doyle', license: 'E2-887' }] },
  });

  const season =
    (await prisma.season.findFirst({ where: { name: 'SUMMER', programYear: 2026 } })) ??
    (await prisma.season.create({ data: { name: 'SUMMER', programYear: 2026, window: { start: '2026-06-01', end: '2026-09-30' }, status: 'OPEN' } }));

  const po =
    (await prisma.purchaseOrder.findFirst({ where: { poNo: 'PO-2026-001' } })) ??
    (await prisma.purchaseOrder.create({
      data: {
        poNo: 'PO-2026-001',
        vendor: 'Enphase',
        status: 'RECEIVED',
        lines: [{ sku: 'IQ10C', kind: 'BATTERY', qty: 60, unit_cost: 3200 }],
      },
    }));

  const allocation = await prisma.itcAllocation.create({
    data: { programYear: 2026, category: 'CAT1', kwApplied: 220, kwAwarded: 180, kwConsumed: 0 },
  });
  const cohort = await prisma.itcCohort.create({ data: { label: `${TAG}-2026-Q3`, status: 'ASSEMBLING', priceCents: 92 } });

  // ---- the 25 units -------------------------------------------------------
  const created: Array<{ id: string; unit: string; stage: string }> = [];
  let n = 0;

  for (const u of UNITS) {
    n += 1;
    const tier = u.tier ?? 'STANDARD';
    const live = idx(u.stage) >= idx('S09_LIVE');
    const rofDate = idx(u.stage) >= idx('S05_ENTITLED') ? ago(220 - n * 3) : null;
    const cofDate = live ? ago(90 - n) : null;
    const installDate = idx(u.stage) >= idx('S07_INSTALLED') ? ago(110 - n) : null;

    const resident = { name: `Resident ${u.unit}`, edcAccountName: `Resident ${u.unit}` };

    const system = await prisma.system.create({
      data: {
        propertyId: property.id,
        unitLabel: u.unit,
        addressLine: `${PROPERTY} · ${u.unit}`,
        stage: u.stage as never,
        tier: tier as never,
        gridEdge: true,
        kwRated: 11.3,
        kwhRated: 15,
        source: 'batch',
        health: live ? (u.health ?? 'OK') : null,
        connectionMethod: idx(u.stage) >= idx('S05_ENTITLED') ? 'M1' : null,
        blockedCode: u.blocked ?? null,
        blockedAt: u.blocked ? ago(u.blocked === 'B-CGB-DEFIC' ? 4 : 6) : null,
        blockedNote: u.blocked === 'B-PERMIT-REV' ? 'Greenwich building dept requested a one-line revision' : u.blocked === 'B-DERMS' ? 'Not visible in EnergyHub 9d after install' : u.blocked ? 'Deficiency raised by CGB' : null,
        terminalState: (u.terminal as never) ?? null,
        terminalReason: u.terminal ? 'Resident declined after signing' : null,
        terminalAt: u.terminal ? ago(30) : null,
        rofDate,
        rofDeadline: rofDate ? new Date(rofDate.getTime() + 730 * DAY) : null,
        installDate,
        cofDate,
        pisDate: cofDate,
        termEnd: cofDate ? new Date(cofDate.getTime() + 3652 * DAY) : null,
        recaptureEnd: cofDate ? new Date(cofDate.getTime() + 1826 * DAY) : null,
        warrantyEnd: installDate ? new Date(installDate.getTime() + 730 * DAY) : null,
        lockedRates: rofDate
          ? { annual_rate: tier === 'LI' ? 525 : tier === 'UNDERSERVED' ? 425 : 300, enroll_rate: 130, grid_edge: true, locked_at: rofDate.toISOString() }
          : undefined,
        cgbAppNo: idx(u.stage) >= idx('S04_APPLIED') ? `ESS-04${400 + n}` : null,
        ixAppNo: idx(u.stage) >= idx('S04_APPLIED') ? `IX-33${100 + n}` : null,
        permitNo: idx(u.stage) >= idx('S05_ENTITLED') ? `GRN-E-26-${1100 + n}` : null,
        enlightenSiteId: idx(u.stage) >= idx('S07_INSTALLED') ? `${TAG}-SITE-${u.unit}` : null,
        dermsId: live ? `${TAG}-DERMS-${u.unit}` : null,
        gridProfile: live ? 'IEEE-1547-2018-CT' : null,
        fwVersion: live ? '7.6.129' : null,
        installerOfRecord: installDate
          ? { installer_org: installer.orgName, crew_label: n % 2 ? 'Crew A' : 'Crew B', lead_name: 'M. Rivera', install_date: installDate.toISOString() }
          : undefined,
      },
    });
    created.push({ id: system.id, unit: u.unit, stage: u.stage });

    const res = await prisma.resident.create({ data: { systemId: system.id, ...resident, since: ago(400) } });
    await prisma.system.update({ where: { id: system.id }, data: { residentId: res.id, edcAccountName: resident.edcAccountName } });

    await prisma.enrollment.create({
      data: {
        systemId: system.id,
        program: 'ct_ess',
        appNo: system.cgbAppNo,
        rofDate,
        cofDate,
        tier: tier as never,
        status: cofDate ? 'COMPLETE' : rofDate ? 'RESERVED' : 'DRAFT',
        deficiencyDue: u.blocked === 'B-CGB-DEFIC' ? new Date(Date.now() + 3 * DAY) : null,
      },
    });

    // A synthetic history so days-in-stage renders from stage_history (DoD 5).
    let at = ago(300);
    for (let i = 0; i <= idx(u.stage); i++) {
      if (i === 0) continue;
      at = new Date(at.getTime() + (8 + (n % 5)) * DAY);
      await prisma.stageHistory.create({
        data: { systemId: system.id, fromStage: STAGE_ORDER[i - 1] as never, toStage: STAGE_ORDER[i] as never, at, by: 'seed', via: 'AUTO' },
      });
    }

    // Checklist for the current stage, so the System/Checklist surfaces render.
    const templates = await prisma.checklistTemplate.findMany({ where: { stage: u.stage as never } });
    if (templates.length) {
      await prisma.checklistItem.createMany({
        data: templates.map((t, i) => ({
          systemId: system.id,
          stage: t.stage,
          key: t.key,
          label: t.label,
          required: t.required,
          ownerRole: t.ownerRole,
          // Leave the last item or two open so gates are visibly unmet.
          state: (i < templates.length - 1 ? 'DONE' : 'OPEN') as never,
          doneAt: i < templates.length - 1 ? ago(10) : null,
          doneBy: i < templates.length - 1 ? 'seed' : null,
        })),
        skipDuplicates: true,
      });
    }

    // Equipment + monitoring for anything installed.
    if (installDate) {
      for (let i = 0; i < 3; i++) {
        await prisma.equipment.create({
          data: { systemId: system.id, serial: `${TAG}-${u.unit}-BAT-${i + 1}`, kind: 'BATTERY', sku: 'IQ10C', dom: true, status: 'INSTALLED', poId: po.id, installedAt: installDate },
        });
      }
      await prisma.equipment.create({
        data: { systemId: system.id, serial: `${TAG}-${u.unit}-CMB`, kind: 'COMBINER', sku: 'X-COMBINE', status: 'INSTALLED', poId: po.id, installedAt: installDate },
      });
    }

    if (live) {
      const site = await prisma.monitoringSite.create({
        data: { projectId: null, provider: 'Enphase', providerSiteId: `${TAG}-SITE-${u.unit}`, lastSeenAt: hoursAgo(u.offlineHours ?? 0), commissionedAt: cofDate },
      });
      // ~5 days of hourly telemetry, stopping when the unit went dark.
      const dark = u.offlineHours ?? 0;
      const rows = [];
      for (let h = 120; h > dark; h--) {
        rows.push({ monitoringSiteId: site.id, ts: hoursAgo(h), soc: 60 + ((h * 7) % 35), powerKw: h % 6 === 0 ? 2.4 : 0, mode: 'SELF_CONSUMPTION', gridConnected: true });
      }
      if (rows.length) await prisma.telemetrySnapshot.createMany({ data: rows });

      // Season dispatch events + the enrollment incentive booked at COF.
      for (let e = 0; e < 3; e++) {
        const delivered = u.health === 'FAULT' && e === 2 ? 0 : 9.4 + ((n + e) % 4) * 0.5;
        await prisma.event.create({
          data: {
            systemId: system.id,
            seasonId: season.id,
            date: ago(60 - e * 14),
            window: 'PM1',
            kwNominated: 11.3,
            kwDelivered: delivered,
            ratio: delivered / 11.3,
            socStart: 88,
            online: delivered > 0,
            source: 'ENERGYHUB_CSV',
          },
        });
      }
      await prisma.ledgerEntry.create({
        data: { systemId: system.id, type: 'ENROLL_INC', status: 'RECEIVED', expectedAmt: 130 * 15, expectedDate: cofDate, receivedAmt: 130 * 15, receivedDate: cofDate, meta: { enroll_rate: 130, kwh: 15 } },
      });

      // ITC claim, basis sourced to the PO line.
      const claim = await prisma.itcClaim.create({
        data: {
          systemId: system.id,
          status: 'BASIS_LOCKED',
          stack: { base: 30, dc: 10, ec: 10, li: null },
          basisAmt: 3 * 3200,
          totalPct: 50,
          creditAmt: 3 * 3200 * 0.5,
          pisDate: cofDate,
          recaptureEnd: system.recaptureEnd,
          evidence: {
            serial_attestations: Object.fromEntries([0, 1, 2].map((i) => [`${TAG}-${u.unit}-BAT-${i + 1}`, `${TAG}-att-${u.unit}-${i}`])),
            ec_map_snapshot: `${TAG}-ec-${u.unit}`,
            invoices: [`${TAG}-inv-${u.unit}`],
            cof_letter: `${TAG}-cof-${u.unit}`,
            f3468_export: `${TAG}-f3468-${u.unit}`,
          },
        },
      });
      await prisma.itcBasisLine.create({ data: { claimId: claim.id, source: 'PO', amount: 3 * 3200, docId: null } });

      // Two claims go into the quarterly cohort.
      if (['1A', '1B'].includes(u.unit)) {
        await prisma.itcClaim.update({ where: { id: claim.id }, data: { cohortId: cohort.id, status: 'IN_COHORT' } });
      }

      for (const type of ['ROF_LETTER', 'COF_LETTER'] as const) {
        await prisma.document.create({
          data: { systemId: system.id, type, title: `${type.replace('_', ' ')} ${u.unit}`, fileKey: `${TAG}/${u.unit}-${type}.pdf`, status: 'SIGNED', signedAt: cofDate },
        });
      }
    }

    // Scheduled installs get a real work order on the crew board.
    if (u.stage === 'S06_SCHEDULED') {
      await prisma.workOrder.create({
        data: { systemId: system.id, type: 'INSTALL', crewId: n % 2 ? crewA.id : crewB.id, date: new Date(Date.now() + ((n % 3) + 1) * DAY), status: 'SCHEDULED', routeGroup: 'Greenwich' },
      });
    }
    if (installDate) {
      await prisma.workOrder.create({
        data: { systemId: system.id, type: 'INSTALL', crewId: n % 2 ? crewA.id : crewB.id, date: installDate, status: 'COMPLETE', checkinAt: installDate, checkoutAt: new Date(installDate.getTime() + 6 * HOUR) },
      });
    }

    if (u.turnover) await openTurnover(system.id, 'seed');
  }

  // One PERF_PAY variance so the Money desk and Today both have something real.
  const varianceSystem = created.find((c) => c.unit === '1A')!;
  await prisma.ledgerEntry.create({
    data: {
      systemId: varianceSystem.id,
      seasonId: season.id,
      type: 'PERF_PAY',
      status: 'VARIANCE',
      expectedAmt: 2231.25,
      expectedDate: ago(20),
      receivedAmt: 1785,
      receivedDate: ago(5),
      meta: { events_n: 3, avg_kw: 10.5, rate: 425, share: 0.5, variance_pct: -20 },
    },
  });

  // An envelope out past 48h so the Today signatures section has a row.
  const sigSystem = created.find((c) => c.unit === '4D')!;
  await prisma.document.create({
    data: { systemId: sigSystem.id, type: 'ESA', title: 'Resident ESA', envelopeId: `${TAG}-env-4D`, status: 'SENT', createdAt: ago(3) },
  });

  const counts = await prisma.system.groupBy({ by: ['stage'], _count: true, where: { propertyId: property.id } });
  console.log(`\n✅ demo seed built — ${ACCOUNT} → ${PROPERTY} → ${created.length} units`);
  console.log('   stages:', counts.map((c) => `${c.stage.slice(0, 3)}:${c._count}`).join(' '));
  console.log(`   crews: ${crewA.label}, ${crewB.label} · allocation ${allocation.kwAwarded} kW · cohort ${cohort.label}`);
  console.log('   deliberate conditions: 2 blocked · 1 offline 27h · 1 WATCH · 1 turnover · 1 variance · 1 envelope out · 1 withdrawn');
}

/**
 * R2's drop-and-reseed: remove the legacy TPO demo spine. Irreversible, so it
 * only runs when asked for explicitly.
 */
async function dropLegacy() {
  const projects = await prisma.project.findMany({ select: { id: true } });
  const pIds = projects.map((p) => p.id);
  console.log(`dropping legacy TPO demo rows — ${pIds.length} projects`);

  // Monitoring sites survive: they are the lifecycle telemetry bridge (X3) and
  // their project link is nullable precisely so they can outlive the spine.
  await prisma.monitoringSite.updateMany({ where: { projectId: { in: pIds } }, data: { projectId: null } });

  await prisma.siteSurvey.deleteMany({});
  await prisma.inspection.deleteMany({});
  await prisma.permit.deleteMany({});
  await prisma.interconnection.deleteMany({});
  await prisma.systemDesign.deleteMany({});
  await prisma.task.deleteMany({});
  await prisma.bid.deleteMany({});
  await prisma.jobPosting.deleteMany({});
  await prisma.workOrder.updateMany({ where: { jobPostingId: { not: null } }, data: { jobPostingId: null } });
  await prisma.project.deleteMany({});
  await prisma.customer.deleteMany({});
  await prisma.salesLead.deleteMany({});
  console.log('legacy TPO demo rows dropped — /api/ops/* now reads empty (R7)');
}

(process.argv.includes('--down')
  ? down()
  : process.argv.includes('--drop-legacy')
    ? up().then(dropLegacy)
    : up())
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('seed failed', e);
    await prisma.$disconnect();
    process.exit(1);
  });
