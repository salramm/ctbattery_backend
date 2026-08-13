/**
 * Letter of Intent. POST is public (the site's LOI step, rate-limited) and returns
 * the generated PDF (base64) for the signer to download. Admin can list all LOIs
 * and download any as a PDF.
 */
import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { HTTP_STATUS } from '../constants/http-status';
import { buildPagination, errorResponse, successResponse } from '../utils/response';
import { validate } from '../middleware/validation';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { createLoiSchema } from '../validators/loiValidator';
import { createLoi, getLoi, listLois } from '../services/loi.service';
import { generateLoiPdf } from '../services/loiPdf.service';

const router = Router();

const submitLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorResponse('TOO_MANY_REQUESTS', 'Too many submissions — please try again later.'),
});

function clientIp(req: Request): string | undefined {
  const xff = (req.headers['x-forwarded-for'] as string) || '';
  return xff.split(',')[0].trim() || req.ip || undefined;
}

// Public: sign an LOI → returns the record + the generated PDF (base64) to download.
router.post('/', submitLimiter, validate(createLoiSchema), async (req, res, next) => {
  try {
    const loi = await createLoi({ ...req.body, signatureIp: clientIp(req) });
    const pdf = await generateLoiPdf(loi);
    res.status(HTTP_STATUS.CREATED).json(
      successResponse({
        id: loi.id,
        loiNumber: loi.loiNumber,
        pdfBase64: pdf.toString('base64'),
      }),
    );
  } catch (err) {
    next(err);
  }
});

// Admin: list
router.get('/', authenticateJWT, requireRole('ADMIN', 'OWNER'), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const sort = req.query.sort === 'recent' ? 'recent' : 'value';
    const { rows, total } = await listLois(page, limit, sort);
    res.json(successResponse(rows, buildPagination(page, limit, total)));
  } catch (err) {
    next(err);
  }
});

// Admin: download a specific LOI as PDF
router.get('/:id/pdf', authenticateJWT, requireRole('ADMIN', 'OWNER'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('INVALID_ID', 'Invalid LOI id'));
  }
  try {
    const loi = await getLoi(id);
    if (!loi) {
      return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('LOI_NOT_FOUND', 'LOI not found'));
    }
    const pdf = await generateLoiPdf(loi);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${loi.loiNumber}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

export default router;
