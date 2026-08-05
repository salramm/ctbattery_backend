/**
 * API JWT sign/verify. The API issues its own token after Firebase verifies the
 * user's identity, so protected routes never re-hit Firebase.
 */
import jwt, { type SignOptions } from 'jsonwebtoken';

export interface JWTPayload {
  userId: number;
  firebaseUid: string;
  email: string;
  role: string;
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export const generateToken = (payload: JWTPayload): string =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as SignOptions);

export const verifyToken = (token: string): JWTPayload =>
  jwt.verify(token, JWT_SECRET) as JWTPayload;
