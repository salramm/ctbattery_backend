/**
 * Waitlist leads. POST is public (the "Join the list" form, rate-limited);
 * GET list is admin-only.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { HTTP_STATUS } from '../constants/http-status';
import { buildPagination, errorResponse, successResponse } from '../utils/response';
import { validate } from '../middleware/validation';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { createLeadSchema } from '../validators/leadValidator';
import { createLead, listLeads } from '../services/lead.service';

const router = Router();

const submitLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorResponse('TOO_MANY_REQUESTS', 'Too many submissions — please try again later.'),
});

// Public: join the waitlist
router.post('/', submitLimiter, validate(createLeadSchema), async (req, res, next) => {
  try {
    const lead = await createLead(req.body);
    res.status(HTTP_STATUS.CREATED).json(successResponse({ id: lead.id, email: lead.email }));
  } catch (err) {
    next(err);
  }
});

// Admin: list leads
router.get('/', authenticateJWT, requireRole('ADMIN', 'OWNER'), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const { rows, total } = await listLeads(page, limit);
    res.json(successResponse(rows, buildPagination(page, limit, total)));
  } catch (err) {
    next(err);
  }
});

export default router;
