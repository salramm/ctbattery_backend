/**
 * GET /api/tariffs?utility=&page=&limit= — paginated C&I rate tariffs, shaped
 * for the TariffTable with computed demand-charge / TOU-spread helpers.
 */
import { Router } from 'express';
import { buildPagination, successResponse } from '../utils/response';
import { listTariffs } from '../services/tariff.service';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const utility = typeof req.query.utility === 'string' ? req.query.utility : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const { rows, total } = await listTariffs(utility, page, limit);
    res.json(successResponse(rows, buildPagination(page, limit, total)));
  } catch (err) {
    next(err);
  }
});

export default router;
