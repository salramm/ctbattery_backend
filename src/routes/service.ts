/**
 * Service loop, crew day board and the field surface (03 §Service, §Field mobile).
 *
 * Thin HTTP layer. The ticket state machine and RMA live in lib/lifecycle;
 * queue/detail in service.service; the board in crew.service; the field steps
 * in field.service. VERIFIED is deliberately unreachable from the transition
 * endpoint — it comes from the rule's machine check.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { HTTP_STATUS } from '../constants/http-status';
import { successResponse } from '../utils/response';
import { authenticateJWT, requireRole } from '../middleware/auth';
import prisma from '../config/database';
import { LifecycleError, logRemoteAttempt, recordRma, transitionTicket, verifyTicket } from '../lib/lifecycle';
import { assignTicket, getQueue, getTicket } from '../services/service.service';
import { getBoard, scheduleWorkOrder } from '../services/crew.service';
import {
  captureSerials,
  captureSignature,
  checkIn,
  checkOut,
  confirmActivation,
  getWorkOrder,
  listAssigned,
  setStep,
  syncOps,
} from '../services/field.service';

function send(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof LifecycleError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.payload ?? {}) });
  }
  return next(err);
}

const actor = (req: Request): string | null => (req.user ? String(req.user.userId) : null);

/** The signed-in account's crew, used to scope the FIELD role. */
async function crewOf(req: Request): Promise<string | undefined> {
  if (!req.user) return undefined;
  const user = await prisma.user.findUnique({ where: { id: Number(req.user.userId) }, select: { crewId: true } });
  return user?.crewId ?? undefined;
}

// ==== /api/tickets ==========================================================
export const ticketsRouter = Router();
ticketsRouter.use(authenticateJWT);

ticketsRouter.get('/', async (req, res, next) => {
  try {
    res.json(
      successResponse(
        await getQueue({
          state: typeof req.query.state === 'string' ? (req.query.state as never) : undefined,
          category: typeof req.query.category === 'string' ? req.query.category : undefined,
          includeClosed: req.query.include_closed === 'true',
        }),
      ),
    );
  } catch (err) {
    send(err, res, next);
  }
});

ticketsRouter.get('/:id', async (req, res, next) => {
  try {
    res.json(successResponse(await getTicket(req.params.id)));
  } catch (err) {
    send(err, res, next);
  }
});

// Move a ticket along. VERIFIED is refused here by design.
ticketsRouter.post('/:id/transition', requireRole('ADMIN', 'OPS', 'FIELD'), async (req, res, next) => {
  try {
    const ticket = await transitionTicket(req.params.id, req.body?.state, {
      resolutionCode: req.body?.resolution_code,
      note: req.body?.note,
      by: actor(req),
    });
    res.json(successResponse({ ticket }));
  } catch (err) {
    send(err, res, next);
  }
});

ticketsRouter.post('/:id/remote', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const ticket = await logRemoteAttempt(req.params.id, {
      step: req.body?.step,
      outcome: req.body?.outcome,
      by: actor(req),
    });
    res.json(successResponse({ ticket }));
  } catch (err) {
    send(err, res, next);
  }
});

ticketsRouter.post('/:id/assign', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const result = await assignTicket(req.params.id, {
      crewId: req.body?.crew_id,
      date: req.body?.date ? new Date(req.body.date) : undefined,
      routeGroup: req.body?.route_group,
      by: actor(req),
    });
    res.json(successResponse(result));
  } catch (err) {
    send(err, res, next);
  }
});

ticketsRouter.post('/:id/rma', requireRole('ADMIN', 'OPS', 'FIELD'), async (req, res, next) => {
  try {
    const result = await recordRma(req.params.id, {
      oldSerial: req.body?.old_serial,
      newSerial: req.body?.new_serial,
      claimNo: req.body?.claim_no,
      sku: req.body?.sku,
      dom: req.body?.dom,
      by: actor(req),
    });
    res.status(HTTP_STATUS.CREATED).json(successResponse(result));
  } catch (err) {
    send(err, res, next);
  }
});

ticketsRouter.post('/:id/verify', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json(successResponse({ verified: await verifyTicket(req.params.id) }));
  } catch (err) {
    send(err, res, next);
  }
});

// ==== /api/crews ============================================================
export const crewsRouter = Router();
crewsRouter.use(authenticateJWT);

crewsRouter.get('/board', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : undefined;
    const days = req.query.days ? Number(req.query.days) : 7;
    res.json(successResponse(await getBoard(from, days)));
  } catch (err) {
    send(err, res, next);
  }
});

crewsRouter.get('/', async (_req, res, next) => {
  try {
    const crews = await prisma.crew.findMany({ include: { installer: true }, orderBy: { label: 'asc' } });
    res.json(successResponse(crews));
  } catch (err) {
    send(err, res, next);
  }
});

// ==== /api/work-orders ======================================================
export const workOrdersRouter = Router();
workOrdersRouter.use(authenticateJWT);

// The board's drag-to-day.
workOrdersRouter.post('/:id/schedule', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const result = await scheduleWorkOrder(req.params.id, {
      crewId: req.body?.crew_id ?? undefined,
      date: req.body?.date ? new Date(req.body.date) : req.body?.date === null ? null : undefined,
      routeGroup: req.body?.route_group,
      by: actor(req),
    });
    res.json(successResponse(result));
  } catch (err) {
    send(err, res, next);
  }
});

// ==== /api/field ============================================================
export const fieldRouter = Router();
fieldRouter.use(authenticateJWT);

fieldRouter.get('/work-orders', async (req, res, next) => {
  try {
    res.json(successResponse(await listAssigned({ crewId: await crewOf(req), role: req.user?.role ?? 'VIEWER' })));
  } catch (err) {
    send(err, res, next);
  }
});

fieldRouter.get('/work-orders/:id', async (req, res, next) => {
  try {
    res.json(successResponse(await getWorkOrder(req.params.id, { crewId: await crewOf(req), role: req.user?.role ?? 'VIEWER' })));
  } catch (err) {
    send(err, res, next);
  }
});

fieldRouter.post('/work-orders/:id/checkin', requireRole('ADMIN', 'OPS', 'FIELD'), async (req, res, next) => {
  try {
    res.json(successResponse(await checkIn(req.params.id, req.body?.gps, actor(req))));
  } catch (err) {
    send(err, res, next);
  }
});

fieldRouter.post('/work-orders/:id/step', requireRole('ADMIN', 'OPS', 'FIELD'), async (req, res, next) => {
  try {
    res.json(successResponse(await setStep(req.params.id, req.body?.key, actor(req))));
  } catch (err) {
    send(err, res, next);
  }
});

fieldRouter.post('/work-orders/:id/serials', requireRole('ADMIN', 'OPS', 'FIELD'), async (req, res, next) => {
  try {
    res.json(successResponse(await captureSerials(req.params.id, req.body?.serials ?? [], actor(req))));
  } catch (err) {
    send(err, res, next);
  }
});

fieldRouter.post('/work-orders/:id/activation', requireRole('ADMIN', 'OPS', 'FIELD'), async (req, res, next) => {
  try {
    res.json(successResponse(await confirmActivation(req.params.id, req.body ?? {}, actor(req))));
  } catch (err) {
    send(err, res, next);
  }
});

fieldRouter.post('/work-orders/:id/signature', requireRole('ADMIN', 'OPS', 'FIELD'), async (req, res, next) => {
  try {
    res.json(successResponse(await captureSignature(req.params.id, req.body ?? {}, actor(req))));
  } catch (err) {
    send(err, res, next);
  }
});

fieldRouter.post('/work-orders/:id/checkout', requireRole('ADMIN', 'OPS', 'FIELD'), async (req, res, next) => {
  try {
    res.json(successResponse(await checkOut(req.params.id, actor(req))));
  } catch (err) {
    send(err, res, next);
  }
});

// Replay a queue captured offline. Every op is idempotent.
fieldRouter.post('/work-orders/:id/sync', requireRole('ADMIN', 'OPS', 'FIELD'), async (req, res, next) => {
  try {
    res.json(successResponse(await syncOps(req.params.id, req.body?.ops ?? [], actor(req))));
  } catch (err) {
    send(err, res, next);
  }
});
