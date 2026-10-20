import {
  CIBIL_REPORT_MAX_BYTES,
  MSG_NET_INCOME_MIN,
  netMonthlyIncomeTooLow,
  storedCibilBand,
} from './loan-rules';

export {
  CIBIL_BANDS,
  CIBIL_REPORT_MAX_BYTES,
  MIN_NET_MONTHLY_INCOME,
  loanNotEligibleMessage,
  storedCibilBand,
  type CibilBand,
} from './loan-rules';

/** Applicant name: letters, spaces, dots. Matches website forms. */
export const LEAD_FULL_NAME_REGEX = /^[A-Za-z][A-Za-z\s.]{1,253}$/;

export function leadFullNameError(name?: string | null): string | null {
  const n = String(name ?? '').trim();
  if (n.length < 2) return 'Full name is required.';
  if (!LEAD_FULL_NAME_REGEX.test(n)) {
    return 'Name should not contain special characters or numbers.';
  }
  return null;
}

/** Stored employment. Old rows stay `salaried`. */
export const STORED_EMPLOYMENT_TYPES = [
  'salaried',
  'salaried_bank',
  'salaried_cash',
  'self_employed',
] as const;

export type StoredEmployment = (typeof STORED_EMPLOYMENT_TYPES)[number];

const CIBIL_REPORT_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

/** Loan apply: income and employment type are both required. */
export function personalLoanEmploymentError(dto: {
  netMonthlyIncome?: number | null;
  employmentType?: string | null;
}): string | null {
  if (netMonthlyIncomeTooLow(dto.netMonthlyIncome)) return MSG_NET_INCOME_MIN;
  if (!storedEmploymentType(dto.employmentType)) {
    return 'Select salaried or self employee / business.';
  }
  return null;
}

export function storedEmploymentType(raw?: string | null): StoredEmployment | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (v === 'salaried' || v === 'salaried_bank' || v === 'salaried_cash' || v === 'self_employed') {
    return v;
  }
  if (v === 'selfemployed') return 'self_employed';
  return null;
}

/** WhatsApp KYC lists: bank and cash salary both use the salaried document list. */
export function kycEmploymentBucket(raw?: string | null): 'salaried' | 'self_employed' | null {
  const stored = storedEmploymentType(raw);
  if (!stored) return null;
  return stored === 'self_employed' ? 'self_employed' : 'salaried';
}

/** CIBIL band and existing EMI. The report file itself is optional. */
export function loanProfileError(dto: {
  cibilBand?: string | null;
  hasExistingEmi?: boolean | null;
  totalMonthlyEmi?: number | null;
}): string | null {
  if (!storedCibilBand(dto.cibilBand)) return 'Select your CIBIL score.';
  if (dto.hasExistingEmi !== true && dto.hasExistingEmi !== false) {
    return 'Tell us if a loan EMI is already running.';
  }
  const emi = Number(dto.totalMonthlyEmi);
  if (dto.hasExistingEmi === false) {
    if (emi !== 0) return 'Total monthly EMI is 0 when no EMI is running.';
    return null;
  }
  if (!Number.isFinite(emi) || emi < 1) return 'Enter the total monthly EMI you pay.';
  return null;
}

export type CibilReportFile = { name: string; mime: string; bytes: Buffer };

/** Optional CIBIL report. Empty means the applicant did not upload one. */
export function readCibilReport(input: {
  cibilReportName?: string | null;
  cibilReportMime?: string | null;
  cibilReportData?: string | null;
}): { ok: true; file: CibilReportFile | null } | { ok: false; message: string } {
  const data = String(input.cibilReportData ?? '').trim();
  const name = String(input.cibilReportName ?? '').trim();
  const mime = String(input.cibilReportMime ?? '').trim().toLowerCase();
  if (!data && !name && !mime) return { ok: true, file: null };
  if (!data || !name || !mime) return { ok: false, message: 'CIBIL report file is incomplete.' };
  if (!CIBIL_REPORT_MIME.has(mime)) return { ok: false, message: 'CIBIL report must be a PDF or image.' };
  const clean = data.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(clean)) return { ok: false, message: 'CIBIL report file is not valid.' };
  const bytes = Buffer.from(clean, 'base64');
  if (!bytes.length || bytes.length > CIBIL_REPORT_MAX_BYTES) {
    return { ok: false, message: 'CIBIL report file is too large.' };
  }
  const safeName = name.replace(/[^\w.\- ()]/g, '').slice(0, 120) || 'cibil-report';
  return { ok: true, file: { name: safeName, mime, bytes } };
}
