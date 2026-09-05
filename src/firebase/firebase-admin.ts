import * as fs from 'fs';
import * as path from 'path';
import * as admin from 'firebase-admin';

let initialized = false;

const DEFAULT_SA_FILENAME = 'firebase-service-account.json';

/** Resolve service-account JSON from env path or common project locations. */
function resolveServiceAccountPath(): string | null {
  const candidates: string[] = [];

  const configured = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  if (configured) {
    if (path.isAbsolute(configured)) {
      candidates.push(configured);
    } else {
      candidates.push(path.resolve(process.cwd(), configured));
      candidates.push(path.resolve(__dirname, '..', '..', configured));
      candidates.push(path.resolve(__dirname, '..', '..', '..', configured));
    }
  }

  // Default filename — no env needed if file sits in server root
  candidates.push(path.resolve(process.cwd(), DEFAULT_SA_FILENAME));
  candidates.push(path.resolve(process.cwd(), 'server', DEFAULT_SA_FILENAME));
  candidates.push(path.resolve(__dirname, '..', '..', DEFAULT_SA_FILENAME));
  candidates.push(path.resolve(__dirname, '..', '..', '..', DEFAULT_SA_FILENAME));

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function readServiceAccountJson(): string | null {
  // Optional override (hosting that cannot ship a file)
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (inline) return inline;

  const resolved = resolveServiceAccountPath();
  if (!resolved) return null;
  try {
    return fs.readFileSync(resolved, 'utf8').trim();
  } catch {
    return null;
  }
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

    // Local/dev only when no file found
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
