import * as admin from 'firebase-admin';

let initialized = false;

export function getFirebaseAdmin(): admin.app.App | null {
  if (initialized && admin.apps.length > 0) {
    return admin.app();
  }

  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();

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

    if (projectId) {
      admin.initializeApp({ projectId });
      initialized = true;
      return admin.app();
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
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
