/**
 * Application routes. POST is public (consumer submit, rate-limited); GET list,
 * GET :id, and PATCH :id status are admin-only.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { ApplicationStatus } from '@prisma/client';
import { HTTP_STATUS } from '../constants/http-status';
import { buildPagination, errorResponse, successResponse } from '../utils/response';
import { validate } from '../middleware/validation';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { imageUpload } from '../middleware/imageUpload';
import {
  createApplicationSchema,
  updateApplicationStatusSchema,
} from '../validators/applicationValidator';
import {
  createApplication,
  getApplication,
  listApplications,
  setApplicationPanelPhoto,
  updateApplicationStatus,
} from '../services/application.service';
import { isStorageConfigured, uploadBuffer } from '../services/storage.service';

const router = Router();

const submitLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorResponse('TOO_MANY_REQUESTS', 'Too many submissions — please try again later.'),
});

const VALID_STATUSES: ApplicationStatus[] = [
  'LEAD',
  'SUBMITTED',
  'RENTER_PENDING',
  'SURVEY_SCHEDULED',
  'SIGNED',
];

// Public: submit an application
router.post('/', submitLimiter, validate(createApplicationSchema), async (req, res, next) => {
  try {
    const application = await createApplication(req.body);
    res.status(HTTP_STATUS.CREATED).json(
      successResponse({
        id: application.id,
        applicationNumber: application.applicationNumber,
        status: application.status,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// Public: upload the electrical-panel photo for an application (rate-limited)
router.post(
  '/:id/panel-photo',
  submitLimiter,
  imageUpload.single('photo'),
  async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('INVALID_ID', 'Invalid application id'));
    }
    if (!req.file) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('NO_FILE', 'No image uploaded (field "photo")'));
    }
    if (!isStorageConfigured()) {
      return res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(errorResponse('STORAGE_NOT_CONFIGURED', 'File storage is not configured on this server yet.'));
    }
    try {
      const existing = await getApplication(id);
      if (!existing) {
        return res
          .status(HTTP_STATUS.NOT_FOUND)
          .json(errorResponse('APPLICATION_NOT_FOUND', 'Application not found'));
      }
      const uploaded = await uploadBuffer(
        'panel-photos',
        req.file.originalname,
        req.file.buffer,
        req.file.mimetype,
      );
      await setApplicationPanelPhoto(id, uploaded.cdnUrl);
      res.status(HTTP_STATUS.CREATED).json(successResponse({ panelPhotoUrl: uploaded.cdnUrl }));
    } catch (err) {
      next(err);
    }
  },
);

// Admin: list
router.get('/', authenticateJWT, requireRole('ADMIN', 'OWNER'), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const statusParam = req.query.status;
    const status =
      typeof statusParam === 'string' && VALID_STATUSES.includes(statusParam as ApplicationStatus)
        ? (statusParam as ApplicationStatus)
        : undefined;
    const { rows, total } = await listApplications(page, limit, status);
    res.json(successResponse(rows, buildPagination(page, limit, total)));
  } catch (err) {
    next(err);
  }
});

// Admin: detail
router.get('/:id', authenticateJWT, requireRole('ADMIN', 'OWNER'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('INVALID_ID', 'Invalid application id'));
  }
  try {
    const application = await getApplication(id);
    if (!application) {
      return res
        .status(HTTP_STATUS.NOT_FOUND)
        .json(errorResponse('APPLICATION_NOT_FOUND', 'Application not found'));
    }
    res.json(successResponse(application));
  } catch (err) {
    next(err);
  }
});

// Admin: update status
router.patch(
  '/:id',
  authenticateJWT,
  requireRole('ADMIN', 'OWNER'),
  validate(updateApplicationStatusSchema),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('INVALID_ID', 'Invalid application id'));
    }
    try {
      const application = await updateApplicationStatus(id, req.body.status);
      res.json(successResponse(application));
    } catch {
      return res
        .status(HTTP_STATUS.NOT_FOUND)
        .json(errorResponse('APPLICATION_NOT_FOUND', 'Application not found'));
    }
  },
);

export default router;
