export const PARTNER_REQUIRED_DOCUMENTS = [
  'AADHAR CARD',
  'PAN CARD',
  'BANK STATEMENT',
  'SALARY SLIP(OPTIONAL)',
  'CURRENT ADDRESS',
  'OFFICE ADDRESS',
] as const;

export type PartnerRequiredDocument = (typeof PARTNER_REQUIRED_DOCUMENTS)[number];

const ALLOWED = new Set<string>(PARTNER_REQUIRED_DOCUMENTS);

export function normalizePartnerDocuments(raw: unknown): PartnerRequiredDocument[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const out: PartnerRequiredDocument[] = [];
  for (const item of list) {
    const value = String(item ?? '').trim();
    if (!ALLOWED.has(value)) continue;
    if (!out.includes(value as PartnerRequiredDocument)) out.push(value as PartnerRequiredDocument);
  }
  return out;
}
