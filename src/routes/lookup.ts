/**
 * POST /api/lookup — resolve an address/coordinate to utility + eligibility +
 * enrichment + tariff defaults. Public (used by the consumer flow and the map).
 */
import { Router } from 'express';
import { successResponse } from '../utils/response';
import { validate } from '../middleware/validation';
import { lookupSchema } from '../validators/lookupValidator';
import { lookup } from '../services/lookup.service';

const router = Router();

router.post('/', validate(lookupSchema), async (req, res, next) => {
  try {
    const result = await lookup(req.body);
    res.json(successResponse(result));
  } catch (err) {
    next(err);
  }
});

export default router;
