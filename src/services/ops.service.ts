/**
 * Read-model aggregations for the legacy TPO operations dashboard + fleet map.
 *
 * LIFECYCLE NOTE (P1 re-model, R7): these `/api/ops/*` surfaces are demo
 * aggregations over the FROZEN spine (`Project`/`SalesLead`/`MonitoringSite`).
 * They are superseded by the lifecycle surfaces in P3–P7 and must NOT be
 * re-pointed at `systems`. Where the P1 re-model reshaped a table away from what
 * these read (`Alert` retargeted to `system_id` — lost `project`/`code`/`message`
 * columns and the INFO/WARN/CRITICAL severities; `WorkOrder` de-marketplaced;
 * `Contractor`→`installers`), the affected bits degrade gracefully rather than
 * being rebuilt. Legacy alert code/message are read back from the new
 * `alerts.context` jsonb.
 */
import prisma from '../config/database';
import type { Prisma } from '@prisma/client';

const DAY = 86400000;

function displayName(first: string, last: string): string {
  return `${first} ${last}`;
}

function alertContext(context: Prisma.JsonValue): { code: string | null; message: string | null } {
  const c = (context ?? {}) as Record<string, unknown>;
  return {
    code: typeof c.legacy_code === 'string' ? c.legacy_code : null,
    message: typeof c.message === 'string' ? c.message : null,
  };
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
    prisma.alert.count({ where: { severity: 'FAULT', clearedAt: null } }),
    prisma.alert.findMany({
      where: { clearedAt: null },
      orderBy: [{ severity: 'desc' }, { openedAt: 'desc' }],
      take: 6,
    }),
  ]);

  const byHealth: Record<string, number> = { OK: 0, WATCH: 0, FAULT: 0, SERVICE: 0 };
  byHealthRaw.forEach((r) => (byHealth[r.health] = r._count));
  const byStage: Record<string, number> = {};
  byStageRaw.forEach((r) => (byStage[r.stage] = r._count));

  const cutoff = new Date(Date.now() - DAY);
  const offline24h = monitoringSites.filter((s) => !s.lastSeenAt || s.lastSeenAt < cutoff).length;

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
    alerts: recentAlerts.map((a) => {
      const { code, message } = alertContext(a.context);
      return {
        id: a.id,
        code,
        message,
        severity: a.severity,
        openedAt: a.openedAt,
        // project scope was removed from Alert in the re-model (retargeted to systems).
        projectId: null as string | null,
        customer: '—',
        town: '—',
      };
    }),
  };
}

async function latestTelemetryBySite(siteIds: string[]) {
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
    },
  });
  const latest = await latestTelemetryBySite(sites.map((s) => s.id));
  const cutoff = new Date(Date.now() - DAY);

  const systems = sites.map((s) => {
    const tel = latest.get(s.id);
    const stale = !s.lastSeenAt || s.lastSeenAt < cutoff;
    const design = s.project.designs[0];
    const hw = design ? `${design.quantity} × ${design.batteryModel.model}` : '—';
    // Fault state came from Alert.code (removed in re-model); status is now telemetry-freshness only.
    let status: string;
    if (stale) {
      const hrs = s.lastSeenAt ? Math.round((Date.now() - s.lastSeenAt.getTime()) / 3600000) : null;
      status = hrs ? `OFFLINE ${hrs}h` : 'OFFLINE';
    } else status = 'ONLINE';
    const soc = !stale && tel ? Math.round(tel.soc) : null;
    return {
      projectId: s.projectId,
      customer: s.project.customer
        ? displayName(s.project.customer.contact.firstName, s.project.customer.contact.lastName)
        : '—',
      town: s.project.siteAddress?.town ?? '—',
      lat: s.project.siteAddress?.lat ?? null,
      lng: s.project.siteAddress?.lng ?? null,
      hw,
      provider: s.provider,
      soc,
      mode: !stale && tel ? tel.mode : '—',
      status,
      state: stale ? 'OFFLINE' : 'ONLINE',
    };
  });

  const online = systems.filter((s) => s.state === 'ONLINE' && s.soc != null);
  const avgSoc = online.length ? Math.round(online.reduce((a, s) => a + (s.soc ?? 0), 0) / online.length) : null;
  const stats = [
    { label: 'Systems live', value: String(systems.length), sub: `across ${new Set(systems.map((s) => s.town)).size} towns`, tone: 'ink' },
    { label: 'Offline > 24h', value: String(systems.filter((s) => s.state === 'OFFLINE').length), sub: 'no recent telemetry', tone: 'bad' },
    { label: 'Critical alerts', value: '—', sub: 'moved to lifecycle Fleet (P7)', tone: 'ink' },
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
    },
  });
  return projects.map((p) => ({
    id: p.id,
    customer: p.customer ? displayName(p.customer.contact.firstName, p.customer.contact.lastName) : '—',
    town: p.siteAddress?.town ?? '—',
    stage: p.stage,
    health: p.health,
    note: STAGE_NOTE[p.stage] ?? '',
    // WorkOrder was de-marketplaced (contractor link removed) in the re-model.
    contractor: '—',
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
        town: l.address?.town ?? '—',
        source: l.source,
        bill: l.estimatedMonthlyBill ? `$${Math.round(Number(l.estimatedMonthlyBill))}/mo` : '—',
        disqualifyReason: l.disqualifyReason,
      })),
  }));
  return { columns };
}

// ---- Installers (formerly Contractors) --------------------------------------
export async function getContractors() {
  // Contractor was migrated in place to `installers` (marketplace framing dropped:
  // no rating/status/counties/certs/expiry, no workOrders/bids relations).
  const rows = await prisma.installer.findMany({ orderBy: { orgName: 'asc' } });
  return rows.map((c) => ({
    id: c.id,
    companyName: c.orgName,
    counties: [] as string[],
    status: null as string | null,
    rating: null as number | null,
    certifications: [] as string[],
    licenseExpiresAt: null as Date | null,
    insuranceExpiresAt: null as Date | null,
    workOrders: 0,
    bids: 0,
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
    town: p.project.siteAddress?.town ?? '—',
    windowStart: p.windowStart,
    windowEnd: p.windowEnd,
    bidsCloseAt: p.bidsCloseAt,
    bidCount: p._count.bids,
    budget: p.budgetCents ? `$${(p.budgetCents / 100).toLocaleString()} cap` : 'T&M',
  }));
}
