/**
 * Inventory rail widget data (05-UI-DELTA D4). Per-SKU on-hand / allocated /
 * available off the one `equipment` table, plus the next open purchase order.
 */
import { Router } from 'express';
import { successResponse } from '../utils/response';
import { authenticateJWT } from '../middleware/auth';
import { getInventorySummary } from '../services/inventory.service';

const router = Router();
router.use(authenticateJWT);

// GET /api/inventory/summary
router.get('/summary', async (_req, res, next) => {
  try {
    res.json(successResponse(await getInventorySummary()));
  } catch (err) {
    next(err);
  }
});

export default router;
