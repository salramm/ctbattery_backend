/**
 * Per-system lifecycle mutations (02 §Endpoints). Thin HTTP layer: parse, call
 * the lib/lifecycle engine, shape the response. All stage logic lives in
 * lib/lifecycle; these handlers never decide a transition.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { HTTP_STATUS } from '../constants/http-status';
import { successResponse } from '../utils/response';
import { validate } from '../middleware/validation';
import { authenticateJWT, requireRole } from '../middleware/auth';
import {
  advance,
  applyChecklist,
  logDocument,
  block,
  unblock,
  terminal,
  openTurnover,
  LifecycleError,
} from '../lib/lifecycle';
import { isStorageConfigured, uploadBuffer } from '../services/storage.service';
import {
  advanceSchema,
  blockSchema,
  unblockSchema,
  terminalSchema,
  checklistSchema,
  docsSchema,
  turnoverSchema,
} from '../validators/lifecycleValidator';
import type { DocumentType } from '@prisma/client';
import { getSystem } from '../services/system.service';

const router = Router();
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/** Translate a thrown LifecycleError into the standard envelope + its extra payload. */
function sendLifecycleError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof LifecycleError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.payload ?? {}) });
  }
  return next(err);
}

const actor = (req: Request): string | null => (req.user ? String(req.user.userId) : null);

router.use(authenticateJWT);

// GET /api/systems/:id — the canonical record (03 §System page)
router.get('/:id', async (req, res, next) => {
  try {
    res.json(successResponse(await getSystem(req.params.id)));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// POST /api/systems/:id/advance
router.post('/:id/advance', requireRole('ADMIN', 'OPS'), validate(advanceSchema), async (req, res, next) => {
  try {
    const result = await advance(req.params.id, { via: req.body.via, reason: req.body.reason, by: actor(req) });
    res.status(HTTP_STATUS.OK).json(successResponse(result));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// POST /api/systems/:id/block
router.post('/:id/block', requireRole('ADMIN', 'OPS'), validate(blockSchema), async (req, res, next) => {
  try {
    const system = await block(req.params.id, req.body.code, req.body.note, actor(req));
    res.status(HTTP_STATUS.OK).json(successResponse({ system }));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// POST /api/systems/:id/unblock
router.post('/:id/unblock', requireRole('ADMIN', 'OPS'), validate(unblockSchema), async (req, res, next) => {
  try {
    const system = await unblock(req.params.id, actor(req));
    res.status(HTTP_STATUS.OK).json(successResponse({ system }));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// POST /api/systems/:id/terminal (admin)
router.post('/:id/terminal', requireRole('ADMIN'), validate(terminalSchema), async (req, res, next) => {
  try {
    const system = await terminal(req.params.id, {
      state: req.body.state,
      reason: req.body.reason,
      acknowledgeClawback: req.body.acknowledge_clawback,
      by: actor(req),
    });
    res.status(HTTP_STATUS.OK).json(successResponse({ system }));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// PATCH /api/systems/:id/checklist
router.patch('/:id/checklist', requireRole('ADMIN', 'OPS', 'FIELD'), validate(checklistSchema), async (req, res, next) => {
  try {
    const result = await applyChecklist(req.params.id, {
      key: req.body.key,
      state: req.body.state,
      docId: req.body.doc_id,
      by: actor(req),
    });
    res.status(HTTP_STATUS.OK).json(successResponse(result));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

// POST /api/systems/:id/docs (multipart; file optional)
router.post(
  '/:id/docs',
  requireRole('ADMIN', 'OPS', 'FIELD'),
  docUpload.single('file'),
  validate(docsSchema),
  async (req, res, next) => {
    try {
      let fileKey: string | undefined;
      if (req.file && isStorageConfigured()) {
        const uploaded = await uploadBuffer(`systems/${req.params.id}`, req.file.originalname, req.file.buffer, req.file.mimetype);
        fileKey = uploaded.key;
      }
      const result = await logDocument({
        systemId: req.params.id,
        type: req.body.type as DocumentType,
        title: req.body.title,
        fileKey,
        by: actor(req),
        date: req.body.date ? new Date(req.body.date) : undefined,
      });
      res.status(HTTP_STATUS.CREATED).json(successResponse(result));
    } catch (err) {
      sendLifecycleError(err, res, next);
    }
  },
);

// POST /api/systems/:id/turnover
router.post('/:id/turnover', requireRole('ADMIN', 'OPS'), validate(turnoverSchema), async (req, res, next) => {
  try {
    const result = await openTurnover(req.params.id, actor(req));
    res.status(HTTP_STATUS.CREATED).json(successResponse(result));
  } catch (err) {
    sendLifecycleError(err, res, next);
  }
});

export default router;
