/**
 * App bootstrap: security headers, CORS allowlist, JSON parsing, health/index
 * routes, resource routers, and the error + 404 handlers. Binds 0.0.0.0 so the
 * container's published port is reachable.
 */
import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { HTTP_STATUS } from './constants/http-status';
import { errorResponse, successResponse } from './utils/response';
import authRouter from './routes/auth';
import lookupRouter from './routes/lookup';
import territoriesRouter from './routes/territories';
import tariffsRouter from './routes/tariffs';
import analyzeRouter from './routes/analyze';
import applicationsRouter from './routes/applications';
import leadsRouter from './routes/leads';
import loiRouter from './routes/loi';
import opsRouter from './routes/ops';
import essRouter from './routes/ess';
import systemsRouter from './routes/systems';
import lifecycleRouter from './routes/lifecycle';
import todayRouter from './routes/today';
import fleetRouter, { alertsRouter, ticketsRouter } from './routes/fleet';
import moneyRouter, { itcRouter } from './routes/money';
import pipelineRouter from './routes/pipeline';
import propertiesRouter from './routes/properties';
import inventoryRouter from './routes/inventory';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SERVICE = 'ctbs-backend';

// Behind a single nginx-proxy in prod: trust it so req.ip / rate-limiting use
// the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);

// In prod browsers hit the same-origin /api proxy; this allowlist covers direct/
// dev access and server-to-server calls (which send no Origin header). Localhost
// dev origins are always allowed (harmless — Origin can't be spoofed cross-site).
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://ctbatterysolutions.com',
  'https://www.ctbatterysolutions.com',
  'http://localhost:3001',
  'http://localhost:3000',
].filter(Boolean) as string[];

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) =>
      !origin || allowedOrigins.includes(origin)
        ? callback(null, true)
        : callback(new Error(`Not allowed by CORS: ${origin}`)),
    credentials: true,
  }),
);

// Lightweight request log: METHOD URL — Origin
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${req.method} ${req.originalUrl} — ${req.headers.origin ?? 'no-origin'}`);
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ==== Health & self-documenting index =========================================
app.get('/health', (_req: Request, res: Response) => {
  res.status(HTTP_STATUS.OK).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: SERVICE,
    port: PORT,
  });
});

app.get('/api', (_req: Request, res: Response) => {
  res.status(HTTP_STATUS.OK).json(
    successResponse({
      service: SERVICE,
      endpoints: {
        'POST /api/auth/login': 'Firebase verify → API JWT',
        'GET  /api/auth/me': 'current user (JWT)',
        'POST /api/lookup': 'address/coords → utility + eligibility (Census geocode) + enrichment',
        'GET  /api/lookup/suggest?q=': 'address typeahead suggestions (Photon, CT-biased)',
        'GET  /api/territories': 'utility-territory GeoJSON (map)',
        'GET  /api/tariffs?utility=&page=&limit=': 'C&I rate tariffs',
        'POST /api/analyze': 'BESS savings model (C&I engine)',
        'POST /api/leads': 'join the waitlist (public)',
        'GET  /api/leads': 'list waitlist leads (admin)',
        'POST /api/loi': 'sign a Letter of Intent → returns PDF (public)',
        'GET  /api/loi': 'list LOIs (admin)',
        'GET  /api/loi/:id/pdf': 'download an LOI PDF (admin)',
        'GET  /api/ops/summary': 'TPO dashboard KPIs (admin)',
        'GET  /api/ops/fleet': 'fleet monitoring map + table (admin)',
        'GET  /api/ops/projects': 'project delivery board (admin)',
        'GET  /api/ops/pipeline': 'sales pipeline by status (admin)',
        'GET  /api/ops/contractors': 'contractor directory (admin)',
        'GET  /api/ops/jobs': 'job board postings (admin)',
        'POST /api/ess/qualify': 'address → ESS compensation tier + ITC adder stack',
        'GET  /api/ess/layers/:name': 'ESS underserved map layers (GeoJSON)',
        'GET  /api/ess/status': 'which ESS datasets are loaded',
        'GET  /api/ess/contractors': 'ESS program contractor directory',
        'GET  /api/ess/contractors/:id': 'ESS contractor profile',
        'POST /api/applications': 'submit a consumer application (public)',
        'POST /api/applications/:id/panel-photo': 'upload panel photo (public)',
        'GET  /api/applications': 'list applications (admin)',
        'GET  /api/applications/:id': 'application detail (admin)',
        'PATCH /api/applications/:id': 'update application status (admin)',
        'GET  /api/lifecycle/map': 'lifecycle state-machine map (stages, gates, block codes, clocks, transitions) from seeds',
        'POST /api/systems/:id/advance': 'advance one stage — MANUAL or OVERRIDE (server-validated gate; 422 unmet list)',
        'POST /api/systems/:id/block': 'set a block code (must belong to the current stage)',
        'POST /api/systems/:id/unblock': 'clear the block code',
        'POST /api/systems/:id/terminal': 'terminalize (admin; REMOVED-in-recapture → 409 clawback)',
        'PATCH /api/systems/:id/checklist': 'set a checklist item state; may fire an AUTO advance',
        'POST /api/systems/:id/docs': 'record a document; ROF/COF letters fire the AUTO chain',
        'POST /api/systems/:id/turnover': 'open a turnover case + TURNOVER flag',
        'GET  /api/today': 'the action queue — five sections composed live, one action per row',
        'GET  /api/fleet': 'fleet lens — season strip, pins, worst-first table, derate vs actual',
        'POST /api/fleet/poll': 'run a monitoring poll pass now',
        'POST /api/alerts/:id/ticket': 'open a ticket for an alert (Today action)',
        'POST /api/tickets/:id/verify': 'run the rule machine check on a claimed resolution',
        'GET  /api/money/incentives': 'enrollment + seasonal ledger rows, expected vs received',
        'POST /api/money/events/import': 'EnergyHub dispatch CSV → events (+ Enlighten cross-check)',
        'POST /api/money/seasons/:id/close': 'write PERF_PAY rows — 0.5 x annual_rate x avg kW (L7)',
        'POST /api/money/statements/import': 'reconcile receipts; >10% gap flips VARIANCE',
        'GET  /api/money/pnl': 'P&L roll-up per system -> property -> fleet',
        'GET  /api/money/pnl.csv': 'P&L export in the exit-calculator column vocabulary',
        'GET  /api/itc/claims': 'ITC claims with basis lines, stack and recapture watch',
        'GET  /api/itc/allocations': '48E(h) allocations — applied/awarded/consumed kW',
        'GET  /api/itc/cohorts': 'cohorts pipeline ASSEMBLING -> CASH_RECEIVED',
        'GET  /api/itc/thread': 'claim-state aggregates behind the Pipeline ITC strip (D5)',
        'GET  /api/itc/cohorts/:id/diligence': 'assemble the diligence ZIP for a cohort',
        'GET  /api/pipeline/board': 'delivery kanban — nine stage columns with per-card gate verdicts',
        'GET  /api/pipeline/filters': 'board filter options (property, town, tier, installer)',
        'GET  /api/pipeline/deals': 'accounts with D1-D7 deal state, unit counts, release meters',
        'GET  /api/properties/:id': 'property header, release meter, unit grid, contacts, batch counts',
        'GET  /api/properties/:id/documents': 'property + unit documents',
        'GET  /api/properties/:id/activity': 'activity feed across the property units',
        'POST /api/properties/:id/batch': 'run a batch action across eligible units (per-unit results)',
        'GET  /api/inventory/summary': 'per-SKU on-hand/allocated/available, buildable, next open PO',
      },
    }),
  );
});

// ==== Resource routers ========================================================
app.use('/api/auth', authRouter);
app.use('/api/lookup', lookupRouter);
app.use('/api/territories', territoriesRouter);
app.use('/api/tariffs', tariffsRouter);
app.use('/api/analyze', analyzeRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/loi', loiRouter);
app.use('/api/ops', opsRouter);
app.use('/api/ess', essRouter);
app.use('/api/systems', systemsRouter);
app.use('/api/lifecycle', lifecycleRouter);
app.use('/api/today', todayRouter);
app.use('/api/fleet', fleetRouter);
app.use('/api/money', moneyRouter);
app.use('/api/itc', itcRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/tickets', ticketsRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/properties', propertiesRouter);
app.use('/api/inventory', inventoryRouter);

// ==== Error + 404 handlers ====================================================
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res
    .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
    .json(errorResponse('INTERNAL_ERROR', err.message || 'Unexpected error'));
});

app.use('*', (_req: Request, res: Response) => {
  res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('NOT_FOUND', 'Route not found'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${SERVICE} listening on http://0.0.0.0:${PORT}`);
});

export default app;
