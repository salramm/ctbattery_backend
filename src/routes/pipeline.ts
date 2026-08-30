/**
 * Pipeline board, Deals list, and the inventory rail (03 §Pipeline, D1/D4/D5).
 * Reads `systems` directly — the legacy /api/ops/* demo aggregation is left
 * untouched and is not re-pointed here (R7).
 */
import { Router } from 'express';
import { successResponse } from '../utils/response';
import { authenticateJWT } from '../middleware/auth';
import { getBoard, getBoardFilters } from '../services/pipeline.service';
import { listDeals } from '../services/accounts.service';

const router = Router();
router.use(authenticateJWT);

// GET /api/pipeline/board?property_id=&tier=&town=&installer=&blocked_only=
router.get('/board', async (req, res, next) => {
  try {
    const board = await getBoard({
      propertyId: typeof req.query.property_id === 'string' ? req.query.property_id : undefined,
      tier: typeof req.query.tier === 'string' ? req.query.tier : undefined,
      town: typeof req.query.town === 'string' ? req.query.town : undefined,
      installer: typeof req.query.installer === 'string' ? req.query.installer : undefined,
      blockedOnly: req.query.blocked_only === 'true',
    });
    res.json(successResponse(board));
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/filters — options for the board's selects
router.get('/filters', async (_req, res, next) => {
  try {
    res.json(successResponse(await getBoardFilters()));
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/deals — accounts with D-state chips, unit counts, release meters
router.get('/deals', async (_req, res, next) => {
  try {
    res.json(successResponse(await listDeals()));
  } catch (err) {
    next(err);
  }
});

export default router;
