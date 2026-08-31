/**
 * Today — the action queue (03 §Today). One GET; the composition lives in
 * today.service and reads live tables on every call.
 */
import { Router } from 'express';
import { successResponse } from '../utils/response';
import { authenticateJWT } from '../middleware/auth';
import { composeToday } from '../services/today.service';

const router = Router();
router.use(authenticateJWT);

// GET /api/today
router.get('/', async (_req, res, next) => {
  try {
    res.json(successResponse(await composeToday()));
  } catch (err) {
    next(err);
  }
});

export default router;
