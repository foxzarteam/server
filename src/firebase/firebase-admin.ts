import * as fs from 'fs';
import * as path from 'path';
import * as admin from 'firebase-admin';

let initialized = false;

function readServiceAccountJson(): string | null {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (inline) return inline;

  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  if (!filePath) return null;

  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) return null;
  return fs.readFileSync(resolved, 'utf8').trim();
}

export function getFirebaseAdmin(): admin.app.App | null {
  if (initialized && admin.apps.length > 0) {
    return admin.app();
  }

  const rawJson = readServiceAccountJson();
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const isProd = process.env.NODE_ENV === 'production';

  try {
    if (rawJson) {
      const serviceAccount = JSON.parse(rawJson) as admin.ServiceAccount;
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: projectId || (serviceAccount as { project_id?: string }).project_id,
      });
      initialized = true;
      return admin.app();
    }

    // Local/dev only — production must use FIREBASE_SERVICE_ACCOUNT_JSON (or PATH).
    if (projectId && !isProd) {
      admin.initializeApp({ projectId });
      initialized = true;
      return admin.app();
    }
  } catch (e) {
    if (!isProd) {
      console.error('Firebase Admin init failed:', e);
    }
  }

  return null;
}

export function normalizeIndianMobile(phone: string | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return digits;
  if (digits.length === 12 && digits.startsWith('91')) {
    const local = digits.slice(2);
    if (/^[6-9]\d{9}$/.test(local)) return local;
  }
  if (phone.startsWith('+91')) {
    const local = phone.slice(3).replace(/\D/g, '');
    if (/^[6-9]\d{9}$/.test(local)) return local;
  }
  return null;
}
