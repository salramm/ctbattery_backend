/**
 * POST /api/analyze — run the BESS savings model for the C&I engine.
 */
import { Router } from 'express';
import { successResponse } from '../utils/response';
import { validate } from '../middleware/validation';
import { analyzeSchema } from '../validators/analyzeValidator';
import { analyze } from '../services/analyze.service';

const router = Router();

router.post('/', validate(analyzeSchema), (req, res) => {
  res.json(successResponse(analyze(req.body)));
});

export default router;
