/**
 * Auth middleware. authenticateJWT verifies the bearer token and attaches
 * req.user; requireRole gates by role.
 */
import { NextFunction, Request, Response } from 'express';
import { HTTP_STATUS } from '../constants/http-status';
import { errorResponse } from '../utils/response';
import { verifyToken } from '../utils/jwt';

export function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res
      .status(HTTP_STATUS.UNAUTHORIZED)
      .json(errorResponse('NO_TOKEN', 'Missing Authorization bearer token'));
  }
  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch {
    return res
      .status(HTTP_STATUS.UNAUTHORIZED)
      .json(errorResponse('INVALID_TOKEN', 'Expired or invalid token'));
  }
}

export const requireRole =
  (...roles: string[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json(errorResponse('FORBIDDEN', 'Insufficient role for this action'));
    }
    next();
  };
