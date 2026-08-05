/**
 * Firebase Admin, initialized lazily from the FIREBASE_SERVICE_ACCOUNT env var
 * (full JSON on one line — never a committed key file). Lazy init means the
 * server still boots for local dev before Firebase is provisioned; auth routes
 * check isFirebaseConfigured() and return a clear error when it isn't.
 */
import admin from 'firebase-admin';

let app: admin.app.App | null = null;

export function isFirebaseConfigured(): boolean {
  return !!process.env.FIREBASE_SERVICE_ACCOUNT;
}

export function getFirebaseAdmin(): admin.app.App {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  app = admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
  return app;
}
