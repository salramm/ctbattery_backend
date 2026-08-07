/**
 * TPO operations dashboard read endpoints. All admin-gated (portal JWT).
 * Data is currently seeded demo data.
 */
import { Router } from 'express';
import { successResponse } from '../utils/response';
import { authenticateJWT, requireRole } from '../middleware/auth';
import {
  getSummary,
  getFleet,
  getProjects,
  getPipeline,
  getContractors,
  getJobs,
} from '../services/ops.service';

const router = Router();

router.use(authenticateJWT, requireRole('ADMIN', 'OWNER'));

router.get('/summary', async (_req, res, next) => {
  try {
    res.json(successResponse(await getSummary()));
  } catch (err) {
    next(err);
  }
});

router.get('/fleet', async (_req, res, next) => {
  try {
    res.json(successResponse(await getFleet()));
  } catch (err) {
    next(err);
  }
});

router.get('/projects', async (_req, res, next) => {
  try {
    res.json(successResponse(await getProjects()));
  } catch (err) {
    next(err);
  }
});

router.get('/pipeline', async (_req, res, next) => {
  try {
    res.json(successResponse(await getPipeline()));
  } catch (err) {
    next(err);
  }
});

router.get('/contractors', async (_req, res, next) => {
  try {
    res.json(successResponse(await getContractors()));
  } catch (err) {
    next(err);
  }
});

router.get('/jobs', async (_req, res, next) => {
  try {
    res.json(successResponse(await getJobs()));
  } catch (err) {
    next(err);
  }
});

export default router;
