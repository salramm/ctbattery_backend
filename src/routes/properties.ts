/**
 * Property page + batch surface (03 §Property page). Thin HTTP layer: the batch
 * runner and every read live in property.service; stage decisions live in
 * lib/lifecycle.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { HTTP_STATUS } from '../constants/http-status';
import { successResponse } from '../utils/response';
import { validate } from '../middleware/validation';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { LifecycleError } from '../lib/lifecycle';
import {
  getProperty,
  getPropertyDocuments,
  getPropertyActivity,
  getBatchCounts,
  runBatch,
  type BatchAction,
} from '../services/property.service';
import { batchSchema } from '../validators/propertyValidator';

const router = Router();

function sendLifecycleError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof LifecycleError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.payload ?? {}) });
  }
  return next(err);
}

const actor = (req: Request): string | null => (req.user ? String(req.user.userId) : null);

router.use(authenticateJWT);

// GET /api/properties/:id — header, release meter, unit grid, contacts
router.get('/:id', async (req, res, next) => {
  try {
    const [property, batchCounts] = await Promise.all([getProperty(req.params.id), getBatchCounts(req.params.id)]);
    res.json(successResponse({ ...property, batch_counts: batchCounts }));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// GET /api/properties/:id/documents
router.get('/:id/documents', async (req, res, next) => {
  try {
    res.json(successResponse(await getPropertyDocuments(req.params.id)));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// GET /api/properties/:id/activity
router.get('/:id/activity', async (req, res, next) => {
  try {
    res.json(successResponse(await getPropertyActivity(req.params.id)));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// POST /api/properties/:id/batch — five actions, per-unit results
router.post('/:id/batch', requireRole('ADMIN', 'OPS'), validate(batchSchema), async (req, res, next) => {
  try {
    const result = await runBatch(
      req.params.id,
      req.body.action as BatchAction,
      req.body.unit_ids as string[] | undefined,
      actor(req),
    );
    res.status(HTTP_STATUS.OK).json(successResponse(result));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

export default router;
