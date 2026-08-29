/**
 * Ambient augmentation so authenticated routes can read `req.user`.
 * Populated by `authenticateJWT` in src/middleware/auth.ts.
 */
import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: number;
        firebaseUid: string | null;
        email: string;
        role: string;
      };
    }
  }
}

export {};
