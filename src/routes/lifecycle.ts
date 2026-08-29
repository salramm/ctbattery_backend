/**
 * Lifecycle reference endpoints. GET /api/lifecycle/map projects the seed tables
 * (checklist_templates + blocked_codes + clocks) + the TRANSITIONS constant into
 * the overlay content (05-UI-DELTA D3). Public: it is reference content and the
 * proof that the seeds are the single source of truth.
 */
import { Router } from 'express';
import { successResponse } from '../utils/response';
import { buildLifecycleMap } from '../lib/lifecycle';

const router = Router();

router.get('/map', async (_req, res, next) => {
  try {
    res.json(successResponse(await buildLifecycleMap()));
  } catch (err) {
    next(err);
  }
});

export default router;
