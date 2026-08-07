/**
 * POST /api/lookup — resolve an address/coordinate to utility + eligibility +
 * enrichment + tariff defaults. Public (used by the consumer flow and the map).
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { successResponse } from '../utils/response';
import { validate } from '../middleware/validation';
import { lookupSchema } from '../validators/lookupValidator';
import { lookup } from '../services/lookup.service';
import { suggestAddresses } from '../services/geocode.service';

const router = Router();

router.post('/', validate(lookupSchema), async (req, res, next) => {
  try {
    const result = await lookup(req.body);
    res.json(successResponse(result));
  } catch (err) {
    next(err);
  }
});

// Typeahead address suggestions (Photon proxy, CT-biased). Generous per-IP cap
// since it fires as the user types (the client debounces).
const suggestLimiter = rateLimit({
  windowMs: 60_000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/suggest', suggestLimiter, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 3) return res.json(successResponse({ suggestions: [] }));
    const suggestions = await suggestAddresses(q);
    res.json(successResponse({ suggestions }));
  } catch (err) {
    next(err);
  }
});

export default router;
