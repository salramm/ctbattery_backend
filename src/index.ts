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

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SERVICE = 'ctbs-backend';

// Behind a single nginx-proxy in prod: trust it so req.ip / rate-limiting use
// the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);

// Browsers hit Netlify's same-origin /api proxy in prod; this allowlist covers
// direct/dev access and server-to-server calls (which send no Origin header).
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3001',
  'https://ctbatterysolutions.com',
  'https://www.ctbatterysolutions.com',
];

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
        'POST /api/applications': 'submit a consumer application (public)',
        'POST /api/applications/:id/panel-photo': 'upload panel photo (public)',
        'GET  /api/applications': 'list applications (admin)',
        'GET  /api/applications/:id': 'application detail (admin)',
        'PATCH /api/applications/:id': 'update application status (admin)',
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
