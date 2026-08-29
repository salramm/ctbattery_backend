/**
 * Seed the lifecycle REFERENCE + INVENTORY tables (P1, 01 §Seed + 05-UI-DELTA D4).
 * The gates read from these tables; the state machine (P2) and today/inventory
 * surfaces (P4/P6) assemble from them. Idempotent: clears + reseeds each table.
 * Stock equipment is namespaced with a `STOCK-` serial prefix so reseeding never
 * touches installed/backfilled units.
 *
 *   npx ts-node src/scripts/seed-lifecycle.ts
 */
import prisma from '../config/database';
import { Prisma } from '@prisma/client';

// ---- checklist_templates (01 §Seed — the gates) -----------------------------
type Tmpl = {
  stage: Prisma.ChecklistTemplateCreateManyInput['stage'];
  key: string;
  label: string;
  required?: boolean;
  conditional?: string | null;
  autoOnly?: boolean;
  ownerRole?: 'ADMIN' | 'OPS' | 'FIELD' | 'VIEWER' | null;
};

const CHECKLIST_TEMPLATES: Tmpl[] = [
  // S02
  { stage: 'S02_QUALIFIED', key: 'contact_confirmed', label: 'Contact confirmed', ownerRole: 'OPS' },
  { stage: 'S02_QUALIFIED', key: 'name_match_verified', label: 'Resident name = EDC account name', ownerRole: 'OPS' },
  // S03
  { stage: 'S03_COMMITTED', key: 'esa_signed', label: 'ESA signed (DocuSign)', ownerRole: 'OPS' },
  { stage: 'S03_COMMITTED', key: 'tc_signed', label: 'CT ESS Terms & Conditions signed', ownerRole: 'OPS' },
  { stage: 'S03_COMMITTED', key: 'payee_designation', label: 'Direct-payment payee designation', ownerRole: 'OPS' },
  { stage: 'S03_COMMITTED', key: 'master_agmt_verified', label: 'Property master agreement verified', conditional: 'property_is_mfah', ownerRole: 'OPS' },
  // S04
  { stage: 'S04_APPLIED', key: 'ix_app_submitted', label: 'Interconnection application submitted (X2)', ownerRole: 'OPS' },
  { stage: 'S04_APPLIED', key: 'cgb_app_submitted', label: 'CGB application submitted (X1) — held until 3-day cancel window', ownerRole: 'OPS' },
  { stage: 'S04_APPLIED', key: 'rof_letter', label: 'ROF letter logged (writes rof_date → auto-advance)', ownerRole: 'OPS' },
  // S05
  { stage: 'S05_ENTITLED', key: 'permit_approved', label: 'Permit approved (X5)', ownerRole: 'OPS' },
  { stage: 'S05_ENTITLED', key: 'ix_approved', label: 'Interconnection approved', ownerRole: 'OPS' },
  { stage: 'S05_ENTITLED', key: 'equipment_allocated', label: '3× battery + combiner + collar serials reserved', ownerRole: 'OPS' },
  { stage: 'S05_ENTITLED', key: 'connection_method_confirmed', label: 'Connection method confirmed (M1 default)', ownerRole: 'OPS' },
  // S06
  { stage: 'S06_SCHEDULED', key: 'crew_assigned', label: 'INSTALL work order with crew + date', ownerRole: 'OPS' },
  { stage: 'S06_SCHEDULED', key: 'resident_confirmed', label: 'Resident SMS confirm + day-before reminder', ownerRole: 'OPS' },
  { stage: 'S06_SCHEDULED', key: 'meter_pull_scheduled', label: 'Meter pull scheduled with EDC', conditional: 'collar_requires_edc_pull', ownerRole: 'OPS' },
  // S07 — field checklist
  { stage: 'S07_INSTALLED', key: 'pre_photos', label: 'Pre-install photos', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'mount_complete', label: 'Mount complete', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'collar_set', label: 'Collar set', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'wired_breakered', label: 'Wired & breakered', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'energized_backup_test', label: 'Energized + backup test', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'post_photos', label: 'Post-install photos', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'serials_scanned', label: 'Serials scanned (writes equipment rows)', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'enlighten_activated', label: 'Enlighten activated (captures X3)', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'grid_profile_fw', label: 'Grid profile + firmware set', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'comms_verified_both', label: 'Comms verified (both paths)', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'resident_walkthrough', label: 'Resident walkthrough', ownerRole: 'FIELD' },
  { stage: 'S07_INSTALLED', key: 'telemetry_confirmed', label: 'Telemetry confirmed by poller (machine closes S07)', autoOnly: true, ownerRole: null },
  // S08
  { stage: 'S08_COMMISSIONED', key: 'inspection_passed', label: 'AHJ inspection passed', conditional: 'ahj_opted', ownerRole: 'OPS' },
  { stage: 'S08_COMMISSIONED', key: 'self_inspection_submitted', label: 'Self-inspection report auto-compiled + submitted', ownerRole: 'OPS' },
  { stage: 'S08_COMMISSIONED', key: 'pto_received', label: 'EDC permission to operate received', ownerRole: 'OPS' },
  { stage: 'S08_COMMISSIONED', key: 'derms_visible', label: 'DERMS visible (poller; captures X4)', autoOnly: true, ownerRole: null },
  { stage: 'S08_COMMISSIONED', key: 'cgb_pkg_accepted', label: 'CGB package accepted', ownerRole: 'OPS' },
  { stage: 'S08_COMMISSIONED', key: 'cof_letter', label: 'COF letter logged (writes cof_date → auto Live → Operating)', ownerRole: 'OPS' },
];

// ---- blocked_codes (01 §Seed) ----------------------------------------------
const BLOCKED_CODES: Array<{ code: string; stage: Tmpl['stage']; label: string; todayAfterDays?: number }> = [
  { code: 'B-CONTACT', stage: 'S02_QUALIFIED', label: 'Cannot reach resident' },
  { code: 'B-NAME-MATCH', stage: 'S02_QUALIFIED', label: 'Resident name ≠ EDC account name' },
  { code: 'B-SIG', stage: 'S03_COMMITTED', label: 'Awaiting signature' },
  { code: 'B-MASTER-AGMT', stage: 'S03_COMMITTED', label: 'Master agreement not on file' },
  { code: 'AWAIT-TPO', stage: 'S03_COMMITTED', label: 'Pre-TPO era — LOI only' },
  { code: 'B-CGB-DEFIC', stage: 'S04_APPLIED', label: 'CGB application deficiency', todayAfterDays: 2 },
  { code: 'B-IX-QUEUE', stage: 'S04_APPLIED', label: 'Interconnection queue' },
  { code: 'B-PERMIT-REV', stage: 'S05_ENTITLED', label: 'Permit corrections requested' },
  { code: 'B-IX-STUDY', stage: 'S05_ENTITLED', label: 'Interconnection study required' },
  { code: 'B-EQUIP', stage: 'S05_ENTITLED', label: 'Equipment unavailable' },
  { code: 'B-M4-UPGRADE', stage: 'S05_ENTITLED', label: 'M4 service upgrade required' },
  { code: 'B-ACCESS', stage: 'S06_SCHEDULED', label: 'Site access issue' },
  { code: 'B-METER-APPT', stage: 'S06_SCHEDULED', label: 'Meter-pull appointment pending' },
  { code: 'B-CREW', stage: 'S06_SCHEDULED', label: 'No crew available' },
  { code: 'B-SITE-COND', stage: 'S07_INSTALLED', label: 'Site condition blocks install' },
  { code: 'B-COMMS', stage: 'S07_INSTALLED', label: 'Comms not established' },
  { code: 'B-INSPECT-FAIL', stage: 'S08_COMMISSIONED', label: 'Inspection failed' },
  { code: 'B-PTO', stage: 'S08_COMMISSIONED', label: 'PTO delayed', todayAfterDays: 14 },
  { code: 'B-DERMS', stage: 'S08_COMMISSIONED', label: 'DERMS not visible', todayAfterDays: 7 },
  { code: 'B-CGB-PKG', stage: 'S08_COMMISSIONED', label: 'CGB package not accepted' },
];

// ---- clocks (01 §Seed) ------------------------------------------------------
const CLOCKS: Array<{ key: string; startsOn: string; lengthMonths?: number | null; lengthDays?: number | null; warnAt?: string; consequence?: string }> = [
  { key: 'rof_build', startsOn: 'rof_date', lengthMonths: 24, warnAt: '18 mo', consequence: 'Reservation expires; file "Extension Request: ESS-#####".' },
  { key: 'cgb_deficiency', startsOn: 'enrollments.deficiency_due', lengthDays: 5, warnAt: 'day 2', consequence: 'Application goes inactive (5 business days).' },
  { key: 'performance_term', startsOn: 'cof_date', lengthMonths: 120, warnAt: '108 mo', consequence: 'Revenue ends; progress bar on Operating systems.' },
  { key: 'itc_recapture', startsOn: 'pis_date', lengthMonths: 60, warnAt: 'on removal intent', consequence: 'Clawback — blocks REMOVED terminal inside window.' },
  { key: 'workmanship', startsOn: 'install_date', lengthMonths: null, warnAt: 'on ticket open', consequence: 'Chargeback-eligible if sub-installed (12–24 mo per installer).' },
  { key: 'li_allocation_window', startsOn: 'annual', lengthMonths: null, warnAt: '60 d before close', consequence: 'Miss window → lose LI adder for the year’s cohort (2026: Feb 2 – Aug 7).' },
  { key: 'turnover_sla', startsOn: 'turnover_cases.opened_at', lengthDays: 30, warnAt: 'day 14', consequence: 'Paperwork lags enrollment compliance.' },
  { key: 'esa_cancellation', startsOn: 'esa_signed done_at', lengthDays: 3, warnAt: 'day 2', consequence: 'Hold CGB submission until the 3-business-day window closes.' },
];

// ---- alert_rules (01 §Alert rules, Flow C) ----------------------------------
const ALERT_RULES: Array<{ key: string; triggerDesc: string; severity: 'WATCH' | 'FAULT'; autoAction: string; verifyDesc: string }> = [
  { key: 'offline_4h', triggerDesc: 'Gateway offline > 4h', severity: 'WATCH', autoAction: 'Resident SMS; no ticket', verifyDesc: 'Reporting resumes' },
  { key: 'offline_24h', triggerDesc: 'Gateway offline > 24h', severity: 'FAULT', autoAction: 'Ticket + remote steps queued', verifyDesc: '48h clean telemetry' },
  { key: 'event_zero', triggerDesc: '0 kW delivered at event', severity: 'FAULT', autoAction: 'Ticket with event context', verifyDesc: 'Next event kW > 0' },
  { key: 'event_low_2x', triggerDesc: 'Ratio < 70% twice in a season', severity: 'WATCH', autoAction: 'Investigation ticket', verifyDesc: 'Ratio ≥ 90% next event' },
  { key: 'comms_30d', triggerDesc: '30-day comms < 95%', severity: 'WATCH', autoAction: 'Flag; batch into route', verifyDesc: '30-day ≥ 97%' },
  { key: 'hw_fault', triggerDesc: 'Hardware fault / thermal', severity: 'FAULT', autoAction: 'Ticket; RMA path pre-suggested', verifyDesc: 'Fault clear + clean event' },
  { key: 'physical', triggerDesc: 'Resident/PM safety report', severity: 'FAULT', autoAction: 'Ticket; same-week priority; safety flag', verifyDesc: 'Field sign-off' },
];

// ---- seasons ----------------------------------------------------------------
const SEASONS: Array<{ name: string; programYear: number; window: { start: string; end: string } }> = [
  { name: 'SUMMER', programYear: 2026, window: { start: '2026-06-01', end: '2026-09-30' } },
  { name: 'WINTER', programYear: 2026, window: { start: '2026-12-01', end: '2027-02-28' } },
];

// ---- rate_tables (R5 — placeholder $/kW-yr flagged CONFIRM) ------------------
// enroll_rate_grid_edge = 130 (UI Grid Edge), enroll_rate_other = 30 (01 §rate_tables).
// annual_rate_kw_yr values are PLACEHOLDERS pending CGB written confirmation (confirm=true).
const RATE_TABLES: Array<{ programYear: number; tier: 'LI' | 'UNDERSERVED' | 'STANDARD'; annual: number }> = [
  { programYear: 2026, tier: 'STANDARD', annual: 200 },
  { programYear: 2026, tier: 'UNDERSERVED', annual: 225 },
  { programYear: 2026, tier: 'LI', annual: 250 },
];

// ---- inventory: one open PO + current stock (D4) -----------------------------
const STOCK = [
  { kind: 'BATTERY' as const, sku: 'IQ10C', qty: 36 },
  { kind: 'COMBINER' as const, sku: 'X-COMBINE', qty: 10 },
  { kind: 'COLLAR' as const, sku: 'X-COLLAR', qty: 10 },
  { kind: 'GATEWAY' as const, sku: 'CELL-KIT', qty: 10 },
];

async function main() {
  console.log('Seeding lifecycle reference + inventory tables…');

  await prisma.$transaction([
    prisma.checklistTemplate.deleteMany(),
    prisma.blockedCode.deleteMany(),
    prisma.clock.deleteMany(),
    prisma.alertRule.deleteMany(),
    prisma.rateTable.deleteMany(),
    prisma.season.deleteMany(),
  ]);
  // Stock equipment + open PO are namespaced so reseeding never touches installed units.
  await prisma.equipment.deleteMany({ where: { serial: { startsWith: 'STOCK-' } } });
  await prisma.purchaseOrder.deleteMany({ where: { poNo: 'PO-2026-001' } });

  await prisma.checklistTemplate.createMany({
    data: CHECKLIST_TEMPLATES.map((t, i) => ({
      stage: t.stage,
      key: t.key,
      label: t.label,
      required: t.required ?? true,
      conditional: t.conditional ?? null,
      autoOnly: t.autoOnly ?? false,
      ownerRole: t.ownerRole ?? null,
      sort: i,
    })),
  });

  await prisma.blockedCode.createMany({
    data: BLOCKED_CODES.map((b) => ({ code: b.code, stage: b.stage, label: b.label, todayAfterDays: b.todayAfterDays ?? 3 })),
  });

  await prisma.clock.createMany({
    data: CLOCKS.map((c) => ({
      key: c.key,
      startsOn: c.startsOn,
      lengthMonths: c.lengthMonths ?? null,
      lengthDays: c.lengthDays ?? null,
      warnAt: c.warnAt ?? null,
      consequence: c.consequence ?? null,
    })),
  });

  await prisma.alertRule.createMany({ data: ALERT_RULES });

  await prisma.season.createMany({
    data: SEASONS.map((s) => ({ name: s.name, programYear: s.programYear, window: s.window })),
  });

  await prisma.rateTable.createMany({
    data: RATE_TABLES.map((r) => ({
      programYear: r.programYear,
      tier: r.tier,
      annualRateKwYr: new Prisma.Decimal(r.annual),
      enrollRateGridEdge: new Prisma.Decimal(130),
      enrollRateOther: new Prisma.Decimal(30),
      confirm: true, // R5 — placeholder, needs CGB written confirmation
    })),
  });

  // Open PO (more stock inbound) + current on-hand IN_STOCK equipment.
  const po = await prisma.purchaseOrder.create({
    data: {
      poNo: 'PO-2026-001',
      vendor: 'Enphase',
      orderedAt: new Date(),
      dueAt: new Date(Date.now() + 30 * 86400000),
      status: 'ORDERED',
      lines: [
        { sku: 'IQ10C', kind: 'BATTERY', qty: 60, unit_cost: 3200 },
        { sku: 'X-COMBINE', kind: 'COMBINER', qty: 20, unit_cost: 450 },
        { sku: 'X-COLLAR', kind: 'COLLAR', qty: 20, unit_cost: 380 },
        { sku: 'CELL-KIT', kind: 'GATEWAY', qty: 20, unit_cost: 210 },
      ],
    },
  });

  const stockRows: Prisma.EquipmentCreateManyInput[] = [];
  for (const s of STOCK) {
    for (let i = 0; i < s.qty; i++) {
      stockRows.push({
        kind: s.kind,
        sku: s.sku,
        serial: `STOCK-${s.sku}-${String(i + 1).padStart(4, '0')}`,
        status: 'IN_STOCK',
      });
    }
  }
  await prisma.equipment.createMany({ data: stockRows });

  const counts = {
    checklist_templates: await prisma.checklistTemplate.count(),
    blocked_codes: await prisma.blockedCode.count(),
    clocks: await prisma.clock.count(),
    alert_rules: await prisma.alertRule.count(),
    rate_tables: await prisma.rateTable.count(),
    seasons: await prisma.season.count(),
    open_pos: await prisma.purchaseOrder.count({ where: { status: 'ORDERED' } }),
    stock_equipment: await prisma.equipment.count({ where: { serial: { startsWith: 'STOCK-' } } }),
  };
  console.log('Seeded:', counts, `(PO ${po.poNo})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
