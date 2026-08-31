/**
 * Fleet lens (03 §Fleet) + the alert/ticket actions the Today queue links to.
 * The legacy /api/ops/fleet demo aggregation is left untouched (R7).
 */
import { Router, type Request } from 'express';
import { HTTP_STATUS } from '../constants/http-status';
import { successResponse, errorResponse } from '../utils/response';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { getFleet } from '../services/fleet.service';
import { pollFleet } from '../services/poller.service';
import { openTicketForAlert } from '../lib/lifecycle';

const router = Router();
router.use(authenticateJWT);

const actor = (req: Request): string | null => (req.user ? String(req.user.userId) : null);

// GET /api/fleet — season strip, pins, worst-first table, derate panel
router.get('/', async (_req, res, next) => {
  try {
    res.json(successResponse(await getFleet()));
  } catch (err) {
    next(err);
  }
});

// POST /api/fleet/poll — run a poll pass now (cron also runs it on a schedule)
router.post('/poll', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const systemId = typeof req.body?.system_id === 'string' ? req.body.system_id : undefined;
    res.json(successResponse(await pollFleet(systemId)));
  } catch (err) {
    next(err);
  }
});

export default router;

// ---- alerts / tickets ------------------------------------------------------
export const alertsRouter = Router();
alertsRouter.use(authenticateJWT);

// POST /api/alerts/:id/ticket — the Today queue's [Open ticket] action
alertsRouter.post('/:id/ticket', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const ticket = await openTicketForAlert(req.params.id, actor(req));
    if (!ticket) {
      return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('ALERT_NOT_FOUND', `No alert ${req.params.id}`));
    }
    res.status(HTTP_STATUS.CREATED).json(successResponse({ ticket }));
  } catch (err) {
    next(err);
  }
});
