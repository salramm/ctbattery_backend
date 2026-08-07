/**
 * Read-model aggregations for the TPO operations dashboard + fleet map.
 * Everything here reads the seeded demo data and shapes it for the portal UI.
 */
import prisma from '../config/database';

const DAY = 86400000;

function displayName(first: string, last: string): string {
  return `${first} ${last}`;
}

// ---- Dashboard summary (KPIs) ----------------------------------------------
export async function getSummary() {
  const since = new Date(Date.now() - 30 * DAY);
  const [
    openLeads,
    qualifiedThisMonth,
    loisOut,
    projectsTotal,
    byHealthRaw,
    byStageRaw,
    monitoringSites,
    criticalAlerts,
    recentAlerts,
  ] = await Promise.all([
    prisma.salesLead.count({ where: { status: { in: ['NEW', 'CONTACTED'] } } }),
    prisma.salesLead.count({ where: { status: 'QUALIFIED', updatedAt: { gte: since } } }),
    prisma.customer.count({ where: { status: 'LOI_SENT' } }),
    prisma.project.count(),
    prisma.project.groupBy({ by: ['health'], _count: true }),
    prisma.project.groupBy({ by: ['stage'], _count: true }),
    prisma.monitoringSite.findMany({ select: { id: true, lastSeenAt: true } }),
    prisma.alert.count({ where: { severity: 'CRITICAL', resolvedAt: null } }),
    prisma.alert.findMany({
      where: { resolvedAt: null },
      orderBy: [{ severity: 'desc' }, { openedAt: 'desc' }],
      take: 6,
      include: { project: { include: { siteAddress: true, customer: { include: { contact: true } } } } },
    }),
  ]);

  const byHealth: Record<string, number> = { ON_TRACK: 0, AT_RISK: 0, BLOCKED: 0 };
  byHealthRaw.forEach((r) => (byHealth[r.health] = r._count));
  const byStage: Record<string, number> = {};
  byStageRaw.forEach((r) => (byStage[r.stage] = r._count));

  const cutoff = new Date(Date.now() - DAY);
  const offline24h = monitoringSites.filter((s) => !s.lastSeenAt || s.lastSeenAt < cutoff).length;

  // Fleet avg SOC from the latest telemetry per site (online sites only).
  const avgSoc = await fleetAvgSoc();

  return {
    pipeline: [
      { label: 'Open leads', value: String(openLeads), sub: 'NEW + CONTACTED' },
      { label: 'Qualified (30d)', value: String(qualifiedThisMonth), sub: 'entered contracting' },
      { label: 'LOIs out', value: String(loisOut), sub: 'awaiting signature' },
      { label: 'Live projects', value: String(projectsTotal), sub: 'in delivery + active' },
    ],
    fleet: [
      { label: 'Systems live', value: String(monitoringSites.length), sub: 'monitored sites', tone: 'ink' },
      { label: 'Offline > 24h', value: String(offline24h), sub: 'no recent telemetry', tone: offline24h ? 'bad' : 'ok' },
      { label: 'Critical alerts', value: String(criticalAlerts), sub: 'need dispatch', tone: criticalAlerts ? 'bad' : 'ok' },
      { label: 'Fleet avg SOC', value: avgSoc == null ? '—' : `${avgSoc}%`, sub: 'across online systems', tone: 'ink' },
    ],
    health: byHealth,
    stages: byStage,
    alerts: recentAlerts.map((a) => ({
      id: a.id,
      code: a.code,
      message: a.message,
      severity: a.severity,
      openedAt: a.openedAt,
      projectId: a.projectId,
      customer: a.project.customer
        ? displayName(a.project.customer.contact.firstName, a.project.customer.contact.lastName)
        : '—',
      town: a.project.siteAddress?.city ?? '—',
    })),
  };
}

async function latestTelemetryBySite(siteIds: string[]) {
  // One query, newest-first; reduce to the latest per site.
  const rows = await prisma.telemetrySnapshot.findMany({
    where: { monitoringSiteId: { in: siteIds } },
    orderBy: { ts: 'desc' },
    select: { monitoringSiteId: true, soc: true, mode: true, ts: true },
  });
  const latest = new Map<string, { soc: number; mode: string; ts: Date }>();
  for (const r of rows) if (!latest.has(r.monitoringSiteId)) latest.set(r.monitoringSiteId, r);
  return latest;
}

async function fleetAvgSoc(): Promise<number | null> {
  const sites = await prisma.monitoringSite.findMany({ select: { id: true } });
  const latest = await latestTelemetryBySite(sites.map((s) => s.id));
  const socs = [...latest.values()].map((v) => v.soc);
  if (!socs.length) return null;
  return Math.round(socs.reduce((a, b) => a + b, 0) / socs.length);
}

// ---- Fleet map + table ------------------------------------------------------
export async function getFleet() {
  const sites = await prisma.monitoringSite.findMany({
    include: {
      project: {
        include: {
          siteAddress: true,
          customer: { include: { contact: true } },
          designs: { where: { isCurrent: true }, include: { batteryModel: true }, take: 1 },
        },
      },
      alerts: { where: { resolvedAt: null }, orderBy: { severity: 'desc' } },
    },
  });
  const latest = await latestTelemetryBySite(sites.map((s) => s.id));
  const cutoff = new Date(Date.now() - DAY);

  const systems = sites.map((s) => {
    const tel = latest.get(s.id);
    const stale = !s.lastSeenAt || s.lastSeenAt < cutoff;
    const critical = s.alerts.find((a) => a.severity === 'CRITICAL');
    const design = s.project.designs[0];
    const hw = design ? `${design.quantity} × ${design.batteryModel.model}` : '—';
    let status: string;
    if (critical) status = `FAULT ${critical.code}`;
    else if (stale) {
      const hrs = s.lastSeenAt ? Math.round((Date.now() - s.lastSeenAt.getTime()) / 3600000) : null;
      status = hrs ? `OFFLINE ${hrs}h` : 'OFFLINE';
    } else status = 'ONLINE';
    const soc = !stale && tel ? Math.round(tel.soc) : null;
    return {
      projectId: s.projectId,
      customer: s.project.customer
        ? displayName(s.project.customer.contact.firstName, s.project.customer.contact.lastName)
        : '—',
      town: s.project.siteAddress?.city ?? '—',
      lat: s.project.siteAddress?.lat ?? null,
      lng: s.project.siteAddress?.lng ?? null,
      hw,
      provider: s.provider,
      soc,
      mode: !stale && tel ? tel.mode : '—',
      status,
      state: critical ? 'FAULT' : stale ? 'OFFLINE' : 'ONLINE',
    };
  });

  const online = systems.filter((s) => s.state === 'ONLINE' && s.soc != null);
  const avgSoc = online.length ? Math.round(online.reduce((a, s) => a + (s.soc ?? 0), 0) / online.length) : null;
  const stats = [
    { label: 'Systems live', value: String(systems.length), sub: `across ${new Set(systems.map((s) => s.town)).size} towns`, tone: 'ink' },
    { label: 'Offline > 24h', value: String(systems.filter((s) => s.state === 'OFFLINE').length), sub: 'no recent telemetry', tone: 'bad' },
    { label: 'Critical alerts', value: String(systems.filter((s) => s.state === 'FAULT').length), sub: 'inverter / battery faults', tone: 'bad' },
    { label: 'Fleet avg SOC', value: avgSoc == null ? '—' : `${avgSoc}%`, sub: 'online systems', tone: 'ink' },
  ];
  return { stats, systems };
}

// ---- Project board ----------------------------------------------------------
const STAGE_NOTE: Record<string, string> = {
  DESIGN: 'System design in progress',
  SITE_SURVEY: 'Field survey scheduled',
  PERMITTING: 'Awaiting AHJ permit approval',
  INTERCONNECTION: 'Utility application in review',
  SCHEDULED: 'Install window set',
  INSTALLED: 'Installed — awaiting inspection',
  INSPECTION: 'AHJ / utility inspection',
  PTO: 'Awaiting permission to operate',
  MONITORING: 'Commissioning telemetry',
  ACTIVE: 'Steady state',
};

export async function getProjects() {
  const projects = await prisma.project.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      siteAddress: true,
      customer: { include: { contact: true } },
      workOrders: { include: { contractor: true }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  return projects.map((p) => ({
    id: p.id,
    customer: p.customer ? displayName(p.customer.contact.firstName, p.customer.contact.lastName) : '—',
    town: p.siteAddress?.city ?? '—',
    stage: p.stage,
    health: p.health,
    note: STAGE_NOTE[p.stage] ?? '',
    contractor: p.workOrders[0]?.contractor.companyName ?? '—',
    monthlyRate: p.monthlyRateCents / 100,
  }));
}

// ---- Sales pipeline ---------------------------------------------------------
export async function getPipeline() {
  const leads = await prisma.salesLead.findMany({
    where: { convertedCustomerId: null }, // still in the funnel
    orderBy: { createdAt: 'desc' },
    include: { contact: true, address: true },
  });
  const columns = ['NEW', 'CONTACTED', 'QUALIFIED', 'DISQUALIFIED'].map((status) => ({
    status,
    leads: leads
      .filter((l) => l.status === status)
      .map((l) => ({
        id: l.id,
        name: displayName(l.contact.firstName, l.contact.lastName),
        town: l.address?.city ?? '—',
        source: l.source,
        bill: l.estimatedMonthlyBill ? `$${Math.round(Number(l.estimatedMonthlyBill))}/mo` : '—',
        disqualifyReason: l.disqualifyReason,
      })),
  }));
  return { columns };
}

// ---- Contractors ------------------------------------------------------------
export async function getContractors() {
  const rows = await prisma.contractor.findMany({
    orderBy: { rating: 'desc' },
    include: { _count: { select: { workOrders: true, bids: true } } },
  });
  return rows.map((c) => ({
    id: c.id,
    companyName: c.companyName,
    counties: c.serviceCounties,
    status: c.status,
    rating: c.rating,
    certifications: c.certifications,
    licenseExpiresAt: c.licenseExpiresAt,
    insuranceExpiresAt: c.insuranceExpiresAt,
    workOrders: c._count.workOrders,
    bids: c._count.bids,
  }));
}

// ---- Job board --------------------------------------------------------------
export async function getJobs() {
  const postings = await prisma.jobPosting.findMany({
    orderBy: { bidsCloseAt: 'asc' },
    include: {
      project: { include: { siteAddress: true, customer: { include: { contact: true } } } },
      _count: { select: { bids: true } },
    },
  });
  return postings.map((p) => ({
    id: p.id,
    scope: p.scope,
    status: p.status,
    county: p.county,
    customer: p.project.customer
      ? displayName(p.project.customer.contact.firstName, p.project.customer.contact.lastName)
      : '—',
    town: p.project.siteAddress?.city ?? '—',
    windowStart: p.windowStart,
    windowEnd: p.windowEnd,
    bidsCloseAt: p.bidsCloseAt,
    bidCount: p._count.bids,
    budget: p.budgetCents ? `$${(p.budgetCents / 100).toLocaleString()} cap` : 'T&M',
  }));
}
