/**
 * Money desks (03 §Money): Incentives, the ITC desk, and the P&L roll-up.
 * Thin HTTP layer — the season math lives in season.service, the claim rules in
 * itc.service, and the pack assembly in diligence.service.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { HTTP_STATUS } from '../constants/http-status';
import { successResponse } from '../utils/response';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { LifecycleError } from '../lib/lifecycle';
import { closeSeason, getIncentives, importEvents, importStatement } from '../services/season.service';
import {
  addToCohort,
  attachEvidence,
  getRecaptureWatch,
  getThread,
  linkAllocation,
  listAllocations,
  listClaims,
  listCohorts,
  rebuildBasis,
  refreshEvidenceState,
  setCohortStatus,
} from '../services/itc.service';
import { assembleDiligencePack } from '../services/diligence.service';
import { exportPnlCsv, getPnl } from '../services/pnl.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function sendLifecycleError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof LifecycleError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.payload ?? {}) });
  }
  return next(err);
}

const actor = (req: Request): string | null => (req.user ? String(req.user.userId) : null);

/** CSV can arrive as a file upload or as a raw `csv` field. */
function csvFrom(req: Request): string | null {
  if (req.file) return req.file.buffer.toString('utf8');
  if (typeof req.body?.csv === 'string' && req.body.csv.trim()) return req.body.csv;
  return null;
}

// ==== /api/money ============================================================
const router = Router();
router.use(authenticateJWT);

// GET /api/money/incentives — enrollment + seasonal rows, expected vs received
router.get('/incentives', async (_req, res, next) => {
  try {
    res.json(successResponse(await getIncentives()));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// POST /api/money/events/import — EnergyHub dispatch CSV
router.post('/events/import', requireRole('ADMIN', 'OPS'), upload.single('file'), async (req, res, next) => {
  try {
    const csv = csvFrom(req);
    if (!csv) throw new LifecycleError(400, 'NO_CSV', 'Attach a CSV file or send a `csv` field');
    const result = await importEvents(csv, {
      seasonId: typeof req.body?.season_id === 'string' ? req.body.season_id : undefined,
      crossCheck: req.body?.cross_check !== 'false',
      by: actor(req),
    });
    res.json(successResponse(result));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// POST /api/money/seasons/:id/close — write the PERF_PAY rows (L7)
router.post('/seasons/:id/close', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(successResponse(await closeSeason(req.params.id, { by: actor(req), force: req.body?.force === true })));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// POST /api/money/statements/import — reconcile receipts onto the same rows
router.post('/statements/import', requireRole('ADMIN', 'OPS'), upload.single('file'), async (req, res, next) => {
  try {
    const csv = csvFrom(req);
    if (!csv) throw new LifecycleError(400, 'NO_CSV', 'Attach a CSV file or send a `csv` field');
    const result = await importStatement(csv, {
      seasonId: typeof req.body?.season_id === 'string' ? req.body.season_id : undefined,
      by: actor(req),
    });
    res.json(successResponse(result));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// GET /api/money/pnl — per-system → property → fleet
router.get('/pnl', async (_req, res, next) => {
  try {
    res.json(successResponse(await getPnl()));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// GET /api/money/pnl.csv — exit-calculator column vocabulary
router.get('/pnl.csv', async (_req, res, next) => {
  try {
    const csv = await exportPnlCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pnl.csv"');
    res.send(csv);
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

export default router;

// ==== /api/itc ==============================================================
export const itcRouter = Router();
itcRouter.use(authenticateJWT);

itcRouter.get('/claims', async (_req, res, next) => {
  try {
    res.json(successResponse(await listClaims()));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

itcRouter.get('/allocations', async (_req, res, next) => {
  try {
    res.json(successResponse(await listAllocations()));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

itcRouter.get('/cohorts', async (_req, res, next) => {
  try {
    res.json(successResponse(await listCohorts()));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

itcRouter.get('/recapture', async (_req, res, next) => {
  try {
    res.json(successResponse(await getRecaptureWatch()));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// D5 — aggregates behind the Pipeline ITC thread strip
itcRouter.get('/thread', async (_req, res, next) => {
  try {
    res.json(successResponse(await getThread()));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

itcRouter.post('/claims/:id/basis', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(successResponse(await rebuildBasis(req.params.id, actor(req))));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

itcRouter.post('/claims/:id/evidence', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(successResponse(await attachEvidence(req.params.id, req.body, actor(req))));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

itcRouter.post('/claims/:id/refresh', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(successResponse({ status: await refreshEvidenceState(req.params.id) }));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

itcRouter.post('/claims/:id/allocation', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(successResponse(await linkAllocation(req.params.id, req.body?.allocation_id, actor(req))));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

itcRouter.post('/cohorts/:id/claims', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const ids: string[] = Array.isArray(req.body?.claim_ids) ? req.body.claim_ids : [];
    res.json(successResponse(await addToCohort(req.params.id, ids, actor(req))));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

itcRouter.post('/cohorts/:id/status', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const result = await setCohortStatus(req.params.id, req.body?.status, {
      buyer: req.body?.buyer,
      price_cents: req.body?.price_cents,
      by: actor(req),
    });
    res.json(successResponse(result));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// GET /api/itc/cohorts/:id/diligence — streams the assembled ZIP
itcRouter.get('/cohorts/:id/diligence', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const pack = await assembleDiligencePack(req.params.id, { by: actor(req) });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${pack.filename}"`);
    // Gaps travel in a header so a caller can tell a short pack from a full one
    // without opening it.
    res.setHeader('X-Diligence-Gaps', String(pack.gaps.length));
    res.status(HTTP_STATUS.OK).send(pack.zip);
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});
