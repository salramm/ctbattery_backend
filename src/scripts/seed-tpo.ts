/**
 * Seed the TPO operations platform with realistic Connecticut DEMO data that
 * powers the dashboard + fleet views. All rows here are illustrative
 * (*Demo purposes). Idempotent: clears the TPO tables, then reseeds.
 *
 *   npx ts-node src/scripts/seed-tpo.ts
 */
import prisma from '../config/database';

// ---- CT geography (approx town centroids for the fleet map) -----------------
const TOWN: Record<string, { county: string; lat: number; lng: number; utility: string }> = {
  Simsbury: { county: 'Hartford', lat: 41.876, lng: -72.801, utility: 'Eversource' },
  Norwalk: { county: 'Fairfield', lat: 41.117, lng: -73.407, utility: 'United Illuminating' },
  Glastonbury: { county: 'Hartford', lat: 41.712, lng: -72.608, utility: 'Eversource' },
  Ellington: { county: 'Tolland', lat: 41.903, lng: -72.469, utility: 'Eversource' },
  'Old Lyme': { county: 'New London', lat: 41.316, lng: -72.339, utility: 'Eversource' },
  Cheshire: { county: 'New Haven', lat: 41.499, lng: -72.901, utility: 'United Illuminating' },
  Danbury: { county: 'Fairfield', lat: 41.394, lng: -73.454, utility: 'Eversource' },
  Woodstock: { county: 'Windham', lat: 41.949, lng: -71.976, utility: 'Eversource' },
  Fairfield: { county: 'Fairfield', lat: 41.141, lng: -73.264, utility: 'United Illuminating' },
  Milford: { county: 'New Haven', lat: 41.222, lng: -73.056, utility: 'United Illuminating' },
  Manchester: { county: 'Hartford', lat: 41.776, lng: -72.521, utility: 'Eversource' },
  Torrington: { county: 'Litchfield', lat: 41.801, lng: -73.121, utility: 'Eversource' },
  Middletown: { county: 'Middlesex', lat: 41.562, lng: -72.651, utility: 'Eversource' },
  Norwich: { county: 'New London', lat: 41.524, lng: -72.076, utility: 'Norwich Public Utilities' },
  Stamford: { county: 'Fairfield', lat: 41.053, lng: -73.539, utility: 'United Illuminating' },
  Guilford: { county: 'New Haven', lat: 41.289, lng: -72.681, utility: 'United Illuminating' },
};

const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 86400000);
const hours = (n: number) => new Date(now.getTime() + n * 3600000);

async function clear() {
  // Delete in FK-safe order.
  await prisma.telemetrySnapshot.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.monitoringSite.deleteMany();
  await prisma.workOrder.deleteMany();
  await prisma.bid.deleteMany();
  await prisma.jobPosting.deleteMany();
  await prisma.inspection.deleteMany();
  await prisma.interconnection.deleteMany();
  await prisma.permit.deleteMany();
  await prisma.siteSurvey.deleteMany();
  await prisma.batteryAsset.deleteMany();
  await prisma.systemDesign.deleteMany();
  await prisma.document.deleteMany();
  await prisma.task.deleteMany();
  await prisma.stageTransition.deleteMany();
  await prisma.project.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.salesLead.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.address.deleteMany();
  await prisma.contractorUser.deleteMany();
  await prisma.contractor.deleteMany();
  await prisma.batteryModel.deleteMany();
  await prisma.ahj.deleteMany();
  await prisma.utility.deleteMany();
  await prisma.platformUser.deleteMany();
}

async function main() {
  console.log('Clearing TPO tables…');
  await clear();

  // ---- Platform users (staff) ----------------------------------------------
  const [alvarez, mercer, okafor, nair] = await Promise.all([
    prisma.platformUser.create({ data: { email: 'j.alvarez@ctbatterysolutions.com', name: 'Jordan Alvarez', role: 'SALES_REP' } }),
    prisma.platformUser.create({ data: { email: 'd.mercer@ctbatterysolutions.com', name: 'Dana Mercer', role: 'OPS' } }),
    prisma.platformUser.create({ data: { email: 's.okafor@ctbatterysolutions.com', name: 'Sam Okafor', role: 'SALES_MANAGER' } }),
    prisma.platformUser.create({ data: { email: 'p.nair@ctbatterysolutions.com', name: 'Priya Nair', role: 'ADMIN' } }),
  ]);

  // ---- Utilities & AHJs -----------------------------------------------------
  const utilByName: Record<string, string> = {};
  for (const [name, code, revDays] of [
    ['Eversource', 'ES', 15],
    ['United Illuminating', 'UI', 20],
    ['Norwich Public Utilities', 'NPU', 10],
  ] as const) {
    const u = await prisma.utility.create({
      data: { name, territoryCode: code, standardReviewDays: revDays, interconnectionPortalUrl: 'https://example.com/ix' },
    });
    utilByName[name] = u.id;
  }
  const ahjByTown: Record<string, string> = {};
  for (const [town, meta] of Object.entries(TOWN)) {
    const a = await prisma.ahj.create({
      data: { name: town, county: meta.county, avgApprovalDays: 18 + (town.length % 10), requiresStructural: town.length % 2 === 0 },
    });
    ahjByTown[town] = a.id;
  }

  // ---- Battery models -------------------------------------------------------
  const franklin = await prisma.batteryModel.create({ data: { manufacturer: 'FranklinWH', model: 'aPower', nameplateKwh: 13.8, continuousKw: 5, chemistry: 'LFP', warrantyYears: 12 } });
  const tesla = await prisma.batteryModel.create({ data: { manufacturer: 'Tesla', model: 'Powerwall 3', nameplateKwh: 13.5, continuousKw: 11.5, chemistry: 'NMC', warrantyYears: 10 } });
  const enphase = await prisma.batteryModel.create({ data: { manufacturer: 'Enphase', model: 'IQ Battery 5P', nameplateKwh: 5, continuousKw: 3.84, chemistry: 'LFP', warrantyYears: 15 } });
  const modelByKey: Record<string, string> = { franklin: franklin.id, tesla: tesla.id, enphase: enphase.id };

  // ---- Contractors ----------------------------------------------------------
  const nutmeg = await prisma.contractor.create({ data: { companyName: 'Nutmeg Electric', licenseNumber: 'E1-40218', licenseExpiresAt: days(600), insuranceExpiresAt: days(150), serviceCounties: ['Hartford', 'Tolland', 'Middlesex'], certifications: ['FranklinWH', 'Tesla'], rating: 4.8, status: 'ACTIVE' } });
  const housatonic = await prisma.contractor.create({ data: { companyName: 'Housatonic Power', licenseNumber: 'E1-38810', licenseExpiresAt: days(480), insuranceExpiresAt: days(40), serviceCounties: ['Fairfield', 'New Haven'], certifications: ['FranklinWH', 'Enphase'], rating: 4.6, status: 'ACTIVE' } });
  const quinnipiac = await prisma.contractor.create({ data: { companyName: 'Quinnipiac Energy', licenseNumber: 'E1-41190', licenseExpiresAt: days(320), insuranceExpiresAt: days(20), serviceCounties: ['New Haven', 'New London'], certifications: ['Tesla'], rating: 4.1, status: 'PENDING' } });
  const contractorByName: Record<string, string> = { 'Nutmeg Electric': nutmeg.id, 'Housatonic Power': housatonic.id, 'Quinnipiac Energy': quinnipiac.id };

  // ---- Helper: build the address→contact→lead→customer→project spine --------
  let seq = 1000;
  async function makeProject(o: {
    first: string; last: string; town: keyof typeof TOWN; line1: string;
    stage: string; health: string; qty: number; modelKey: string; rate: number;
    pmId?: string;
  }) {
    const meta = TOWN[o.town];
    const address = await prisma.address.create({
      data: {
        line1: o.line1, city: o.town, state: 'CT', postalCode: '060' + (10 + (seq % 90)),
        county: meta.county, lat: meta.lat + (Math.sin(seq) * 0.03), lng: meta.lng + (Math.cos(seq) * 0.03),
        utilityId: utilByName[meta.utility], ahjId: ahjByTown[o.town],
      },
    });
    const contact = await prisma.contact.create({
      data: { firstName: o.first, lastName: o.last, email: `${o.first}.${o.last}${seq}@example.com`.toLowerCase(), phone: `(860) 555-0${100 + (seq % 900)}` },
    });
    const lead = await prisma.salesLead.create({
      data: { addressId: address.id, contactId: contact.id, ownerId: alvarez.id, source: 'REFERRAL', status: 'QUALIFIED', estimatedMonthlyBill: 300 + (seq % 400) },
    });
    const customer = await prisma.customer.create({
      data: { leadId: lead.id, contactId: contact.id, serviceAddressId: address.id, status: 'AGREEMENT_SIGNED', creditTier: 'A' },
    });
    await prisma.salesLead.update({ where: { id: lead.id }, data: { convertedCustomerId: customer.id } });
    const project = await prisma.project.create({
      data: {
        customerId: customer.id, siteAddressId: address.id, stage: o.stage as never, health: o.health as never,
        projectManagerId: o.pmId ?? mercer.id, monthlyRateCents: o.rate * 100, termYears: 20,
        targetPtoDate: days(40 + (seq % 60)),
        actualPtoDate: ['ACTIVE', 'MONITORING'].includes(o.stage) ? days(-(20 + (seq % 60))) : null,
      },
    });
    const model = modelByKey[o.modelKey];
    const bm = o.modelKey === 'franklin' ? franklin : o.modelKey === 'tesla' ? tesla : enphase;
    await prisma.systemDesign.create({
      data: {
        projectId: project.id, version: 1, batteryModelId: model, quantity: o.qty,
        usableKwh: Number(bm.nameplateKwh) * o.qty, continuousKw: Number(bm.continuousKw) * o.qty,
        inverterModel: `${bm.manufacturer} integrated`, solarCoupled: seq % 2 === 0, isCurrent: true,
        backupLoads: ['well pump', 'refrigerator', 'furnace', 'sump'].slice(0, 2 + (seq % 3)),
      },
    });
    for (let i = 0; i < o.qty; i++) {
      await prisma.batteryAsset.create({
        data: {
          batteryModelId: model, projectId: project.id, serialNumber: `${bm.manufacturer.slice(0, 3).toUpperCase()}-${seq}-${i}`,
          status: ['ACTIVE', 'MONITORING', 'INSTALLED', 'PTO', 'INSPECTION'].includes(o.stage) ? 'INSTALLED' : 'ALLOCATED',
          installedAt: ['ACTIVE', 'MONITORING'].includes(o.stage) ? days(-30) : null, warrantyEndsAt: days(365 * bm.warrantyYears),
        },
      });
    }
    seq++;
    return { address, contact, lead, customer, project, meta };
  }

  // ---- Delivery-stage projects (the board) ---------------------------------
  const whitfield = await makeProject({ first: 'Eleanor', last: 'Whitfield', town: 'Old Lyme', line1: '1102 Shore Rd', stage: 'PERMITTING', health: 'AT_RISK', qty: 2, modelKey: 'franklin', rate: 149 });
  const osei = await makeProject({ first: 'Gabriel', last: 'Osei', town: 'Ellington', line1: '45 Pinney St', stage: 'SITE_SURVEY', health: 'ON_TRACK', qty: 1, modelKey: 'franklin', rate: 119 });
  await makeProject({ first: 'Owen', last: 'Delacroix', town: 'Cheshire', line1: '9 Barnes Hill', stage: 'SCHEDULED', health: 'ON_TRACK', qty: 2, modelKey: 'tesla', rate: 139 });
  const raghunathan = await makeProject({ first: 'Priya', last: 'Raghunathan', town: 'Glastonbury', line1: '77 Copper Hill Rd', stage: 'INSPECTION', health: 'BLOCKED', qty: 2, modelKey: 'franklin', rate: 155 });
  const bruno = await makeProject({ first: 'Anthony', last: 'Bruno', town: 'Norwalk', line1: '204 Sachem St', stage: 'PTO', health: 'ON_TRACK', qty: 1, modelKey: 'enphase', rate: 99 });

  // ---- Compliance / jobs on delivery projects ------------------------------
  await prisma.permit.create({ data: { projectId: whitfield.project.id, ahjId: ahjByTown['Old Lyme'], type: 'ELECTRICAL', number: 'PRM-88', status: 'CORRECTIONS', submittedAt: days(-12) } });
  await prisma.permit.create({ data: { projectId: whitfield.project.id, ahjId: ahjByTown['Old Lyme'], type: 'BUILDING', number: 'PRM-89', status: 'APPROVED', submittedAt: days(-14), approvedAt: days(-6) } });
  await prisma.interconnection.create({ data: { projectId: whitfield.project.id, utilityId: utilByName['Eversource'], applicationNumber: 'IX-40921', status: 'APPROVED_TO_INSTALL', submittedAt: days(-20), approvedAt: days(-8), programEnrollment: 'CT Energy Storage Solutions' } });
  await prisma.interconnection.create({ data: { projectId: bruno.project.id, utilityId: utilByName['United Illuminating'], applicationNumber: 'IX-40833', status: 'PTO_GRANTED', submittedAt: days(-60), approvedAt: days(-30), ptoAt: days(-5), programEnrollment: 'CT Energy Storage Solutions' } });
  await prisma.inspection.create({ data: { projectId: raghunathan.project.id, type: 'AHJ_FINAL', result: 'FAIL', scheduledAt: days(-3) } });

  // JobPosting + bids on the Whitfield install
  const posting = await prisma.jobPosting.create({
    data: { projectId: whitfield.project.id, scope: 'INSTALL', county: 'New London', budgetCents: 520000, windowStart: days(11), windowEnd: days(15), bidsCloseAt: days(2), status: 'OPEN' },
  });
  await prisma.bid.create({ data: { jobPostingId: posting.id, contractorId: nutmeg.id, amountCents: 485000, proposedStart: days(11), status: 'SUBMITTED' } });
  await prisma.bid.create({ data: { jobPostingId: posting.id, contractorId: quinnipiac.id, amountCents: 441000, proposedStart: days(18), status: 'SUBMITTED' } });
  await prisma.bid.create({ data: { jobPostingId: posting.id, contractorId: housatonic.id, amountCents: 512000, proposedStart: days(26), status: 'SUBMITTED' } });

  // Awarded survey posting + work order on Osei
  const surveyPosting = await prisma.jobPosting.create({ data: { projectId: osei.project.id, scope: 'SITE_SURVEY', county: 'Tolland', budgetCents: 45000, windowStart: days(4), windowEnd: days(6), bidsCloseAt: days(-1), status: 'AWARDED' } });
  const surveyBid = await prisma.bid.create({ data: { jobPostingId: surveyPosting.id, contractorId: housatonic.id, amountCents: 39500, proposedStart: days(4), status: 'WON' } });
  await prisma.jobPosting.update({ where: { id: surveyPosting.id }, data: { awardedBidId: surveyBid.id } });
  const surveyWo = await prisma.workOrder.create({ data: { jobPostingId: surveyPosting.id, projectId: osei.project.id, contractorId: housatonic.id, scope: 'SITE_SURVEY', status: 'SCHEDULED', scheduledAt: days(4) } });
  await prisma.siteSurvey.create({ data: { projectId: osei.project.id, workOrderId: surveyWo.id, status: 'SCHEDULED', scheduledAt: days(4) } });

  // Tasks + documents + a couple stage transitions
  await prisma.task.create({ data: { projectId: whitfield.project.id, assigneeId: mercer.id, title: 'Revise one-line for AHJ', dueAt: days(1), status: 'OPEN' } });
  await prisma.task.create({ data: { projectId: whitfield.project.id, assigneeId: alvarez.id, title: 'Confirm backup load list with homeowner', status: 'OPEN' } });
  await prisma.document.create({ data: { customerId: whitfield.customer.id, projectId: whitfield.project.id, type: 'TPO_AGREEMENT', status: 'SIGNED', signedAt: days(-35), fileUrl: 'https://example.com/doc' } });
  await prisma.stageTransition.create({ data: { subjectType: 'PROJECT', subjectId: whitfield.project.id, fromStage: 'INTERCONNECTION', toStage: 'PERMITTING', actorId: mercer.id, occurredAt: days(-4), note: 'auto' } });

  // ---- Active fleet systems (monitoring) -----------------------------------
  type Fleet = { first: string; last: string; town: keyof typeof TOWN; line1: string; qty: number; modelKey: string; rate: number; soc: number | null; mode: string; state: 'ONLINE' | 'FAULT' | 'OFFLINE' };
  const fleet: Fleet[] = [
    { first: 'Marisol', last: 'Reyes', town: 'Simsbury', line1: '18 Ridgefield Ln', qty: 2, modelKey: 'franklin', rate: 149, soc: 94, mode: 'SELF_CONSUMPTION', state: 'ONLINE' },
    { first: 'Renata', last: 'Kowalczyk', town: 'Fairfield', line1: '530 Mill Pond', qty: 1, modelKey: 'enphase', rate: 89, soc: 62, mode: 'GRID_SERVICES', state: 'ONLINE' },
    { first: 'Diego', last: 'Carrasco', town: 'Danbury', line1: '14 Deer Run', qty: 2, modelKey: 'tesla', rate: 139, soc: null, mode: '—', state: 'OFFLINE' },
    { first: 'Astrid', last: 'Lindqvist', town: 'Woodstock', line1: '3 Hillcrest Farm Rd', qty: 3, modelKey: 'franklin', rate: 179, soc: 71, mode: 'GRID_SERVICES', state: 'ONLINE' },
    { first: 'Marcus', last: 'Bell', town: 'Manchester', line1: '88 Spencer St', qty: 1, modelKey: 'franklin', rate: 109, soc: 88, mode: 'SELF_CONSUMPTION', state: 'ONLINE' },
    { first: 'Yuki', last: 'Tanaka', town: 'Milford', line1: '210 Gulf St', qty: 2, modelKey: 'tesla', rate: 145, soc: 55, mode: 'SELF_CONSUMPTION', state: 'ONLINE' },
    { first: 'Fatima', last: 'Nasser', town: 'Torrington', line1: '5 Highland Ave', qty: 2, modelKey: 'franklin', rate: 152, soc: 22, mode: 'BACKUP', state: 'FAULT' },
    { first: 'Cole', last: 'Whitaker', town: 'Middletown', line1: '61 Washington St', qty: 1, modelKey: 'enphase', rate: 95, soc: 79, mode: 'SELF_CONSUMPTION', state: 'ONLINE' },
    { first: 'Grace', last: "O'Brien", town: 'Guilford', line1: '22 Whitfield St', qty: 2, modelKey: 'franklin', rate: 149, soc: 91, mode: 'SELF_CONSUMPTION', state: 'ONLINE' },
    { first: 'Hassan', last: 'Ali', town: 'Stamford', line1: '400 Bedford St', qty: 2, modelKey: 'tesla', rate: 159, soc: 67, mode: 'GRID_SERVICES', state: 'ONLINE' },
    { first: 'Elena', last: 'Popov', town: 'Norwich', line1: '77 Broadway', qty: 1, modelKey: 'franklin', rate: 105, soc: 83, mode: 'SELF_CONSUMPTION', state: 'ONLINE' },
    { first: 'Reyes', last: 'Household', town: 'Glastonbury', line1: '5 Addison Rd', qty: 2, modelKey: 'franklin', rate: 149, soc: null, mode: '—', state: 'OFFLINE' },
  ];

  for (const s of fleet) {
    const { project } = await makeProject({
      first: s.first, last: s.last, town: s.town, line1: s.line1,
      stage: 'ACTIVE', health: s.state === 'FAULT' ? 'BLOCKED' : s.state === 'OFFLINE' ? 'AT_RISK' : 'ON_TRACK',
      qty: s.qty, modelKey: s.modelKey, rate: s.rate,
    });
    const ms = await prisma.monitoringSite.create({
      data: {
        projectId: project.id, provider: s.modelKey === 'tesla' ? 'Tesla' : s.modelKey === 'enphase' ? 'Enphase' : 'FranklinWH',
        providerSiteId: `SITE-${seq}`, commissionedAt: days(-40),
        lastSeenAt: s.state === 'OFFLINE' ? hours(-31) : hours(-1),
      },
    });
    // Recent telemetry (skip for offline to reflect stale data)
    if (s.state !== 'OFFLINE' && s.soc != null) {
      for (let h = 6; h >= 0; h--) {
        await prisma.telemetrySnapshot.create({
          data: {
            monitoringSiteId: ms.id, ts: hours(-h),
            soc: Math.max(5, Math.min(100, s.soc + (h - 3) * 2)),
            powerKw: s.mode === 'BACKUP' ? -2.1 : Number((Math.sin(h) * 3).toFixed(2)),
            mode: s.mode, gridConnected: s.mode !== 'BACKUP',
          },
        });
      }
    }
    if (s.state === 'FAULT') {
      await prisma.alert.create({ data: { monitoringSiteId: ms.id, projectId: project.id, code: 'F204', message: 'Inverter fault F204 — battery isolated', severity: 'CRITICAL', openedAt: hours(-9) } });
    } else if (s.state === 'OFFLINE') {
      await prisma.alert.create({ data: { monitoringSiteId: ms.id, projectId: project.id, code: 'COMMS', message: 'No telemetry received in 24h+', severity: 'WARN', openedAt: hours(-31) } });
    }
  }

  // ---- Extra pipeline leads (not converted) --------------------------------
  const pipeline: Array<{ first: string; last: string; town: keyof typeof TOWN; line1: string; source: string; status: string; bill: number; dq?: string }> = [
    { first: 'Nadia', last: 'Haddad', town: 'Simsbury', line1: '2 Firetown Rd', source: 'REFERRAL', status: 'NEW', bill: 412 },
    { first: 'Theo', last: 'Larsen', town: 'Norwalk', line1: '9 Water St', source: 'WEB', status: 'NEW', bill: 338 },
    { first: 'Amara', last: 'Okonkwo', town: 'Glastonbury', line1: '18 Hebron Ave', source: 'PARTNER', status: 'CONTACTED', bill: 505 },
    { first: 'Ben', last: 'Sorensen', town: 'Cheshire', line1: '31 Highland Ave', source: 'CANVASS', status: 'CONTACTED', bill: 291 },
    { first: 'Lucia', last: 'Ferrante', town: 'Middletown', line1: '7 Court St', source: 'UTILITY_LIST', status: 'QUALIFIED', bill: 688 },
    { first: 'Omar', last: 'Farouk', town: 'Milford', line1: '55 Naugatuck Ave', source: 'WEB', status: 'QUALIFIED', bill: 374 },
    { first: 'Greta', last: 'Vogel', town: 'Fairfield', line1: '12 Beach Rd', source: 'REFERRAL', status: 'DISQUALIFIED', bill: 180, dq: 'Renter — not owner-occupant' },
  ];
  for (const l of pipeline) {
    const meta = TOWN[l.town];
    const address = await prisma.address.create({ data: { line1: l.line1, city: l.town, state: 'CT', postalCode: '060' + (10 + (seq % 90)), county: meta.county, lat: meta.lat, lng: meta.lng, utilityId: utilByName[meta.utility], ahjId: ahjByTown[l.town] } });
    const contact = await prisma.contact.create({ data: { firstName: l.first, lastName: l.last, email: `${l.first}.${l.last}${seq}@example.com`.toLowerCase(), phone: `(203) 555-0${100 + (seq % 900)}` } });
    await prisma.salesLead.create({ data: { addressId: address.id, contactId: contact.id, ownerId: alvarez.id, source: l.source as never, status: l.status as never, estimatedMonthlyBill: l.bill, disqualifyReason: l.dq } });
    seq++;
  }

  // ---- Contractor users -----------------------------------------------------
  const cu = await prisma.platformUser.create({ data: { email: 'admin@nutmegelectric.com', name: 'Nutmeg Admin', role: 'CONTRACTOR' } });
  await prisma.contractorUser.create({ data: { contractorId: nutmeg.id, userId: cu.id, role: 'ADMIN' } });

  // ---- Summary --------------------------------------------------------------
  const [projects, leads, sites, alerts] = await Promise.all([
    prisma.project.count(), prisma.salesLead.count(), prisma.monitoringSite.count(), prisma.alert.count(),
  ]);
  console.log(`Seeded: ${projects} projects, ${leads} leads, ${sites} monitoring sites, ${alerts} alerts.`);
  console.log('Staff:', [alvarez, mercer, okafor, nair].map((u) => u.name).join(', '));
  console.log('Contractors:', Object.keys(contractorByName).join(', '));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
