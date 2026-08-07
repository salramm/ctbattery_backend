/**
 * Auth routes. POST /login verifies a Firebase ID token, upserts the user, and
 * issues an API JWT. GET /me returns the current user.
 */
import { Router } from 'express';
import { HTTP_STATUS } from '../constants/http-status';
import { errorResponse, successResponse } from '../utils/response';
import { validate } from '../middleware/validation';
import { authenticateJWT } from '../middleware/auth';
import { loginSchema } from '../validators/authValidator';
import { getFirebaseAdmin, isFirebaseConfigured } from '../config/firebase';
import { generateToken } from '../utils/jwt';
import prisma from '../config/database';

const router = Router();

// Fail-closed admin allowlist: only these emails may exchange a Firebase token
// for an admin JWT. Set via ADMIN_EMAILS (comma-separated) in the backend env.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

router.post('/login', validate(loginSchema), async (req, res) => {
  if (!isFirebaseConfigured()) {
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json(errorResponse('FIREBASE_NOT_CONFIGURED', 'Authentication is not configured on this server yet.'));
  }
  try {
    const decoded = await getFirebaseAdmin().auth().verifyIdToken(req.body.idToken);
    const email = (decoded.email ?? '').toLowerCase();
    if (!email || !ADMIN_EMAILS.includes(email)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json(errorResponse('NOT_AUTHORIZED', 'This account is not an authorized admin.'));
    }
    const user = await prisma.user.upsert({
      where: { firebaseUid: decoded.uid },
      update: { email },
      create: { firebaseUid: decoded.uid, email, name: decoded.name ?? null, role: 'ADMIN' },
    });
    const token = generateToken({
      userId: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      role: user.role,
    });
    return res.status(HTTP_STATUS.OK).json(successResponse({ token, user }));
  } catch {
    return res
      .status(HTTP_STATUS.UNAUTHORIZED)
      .json(errorResponse('INVALID_TOKEN', 'Could not verify the Firebase token'));
  }
});

router.get('/me', authenticateJWT, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user) {
    return res
      .status(HTTP_STATUS.NOT_FOUND)
      .json(errorResponse('USER_NOT_FOUND', 'User not found'));
  }
  return res.json(successResponse(user));
});

export default router;
