/**
 * Directory — six object counts for the "every object · two clicks" screen
 * (mockup §8). Scalars only; each tile links into the surface that lists them.
 */
import { Router } from 'express';
import { successResponse } from '../utils/response';
import { authenticateJWT } from '../middleware/auth';
import { getDirectorySummary } from '../services/directory.service';

const router = Router();
router.use(authenticateJWT);

// GET /api/directory/summary
router.get('/summary', async (_req, res, next) => {
  try {
    res.json(successResponse(await getDirectorySummary()));
  } catch (err) {
    next(err);
  }
});

export default router;
