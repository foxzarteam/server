/** Admin inbox menu. Same names are approved on Meta. Admin can send each one again. */
export const ADMIN_WA_TEMPLATES = [
  { id: 'application_kyc', label: 'Application KYC', metaName: 'application_kyc', kyc: true },
  { id: 'vehicle_refinance_kyc', label: 'Vehicle KYC (RC Wala)', metaName: 'vehicle_refinance_kyc', kyc: true },
  { id: 'vehicle_purchase_kyc', label: 'Vehicle Purchase KYC (Quotation Wala)', metaName: 'vehicle_purchase_kyc', kyc: true },
  { id: 'personal_loan_kyc', label: 'Personal Loan KYC', metaName: 'personal_loan_kyc', kyc: true },
  { id: 'document_pending_reminder', label: 'Document Pending Reminder', metaName: 'document_pending_reminder', kyc: false },
  { id: 'call_not_answered_followup', label: 'Call Not Answered', metaName: 'call_not_answered_followup', kyc: false },
] as const;

export type AdminWaTemplateId = (typeof ADMIN_WA_TEMPLATES)[number]['id'];

export type MetaTemplateButton = { type?: string; text?: string; url?: string };
export type MetaTemplateComponent = {
  type?: string;
  text?: string;
  format?: string;
  buttons?: MetaTemplateButton[];
};
export type MetaTemplateDefinition = {
  name?: string;
  status?: string;
  language?: string;
  components?: MetaTemplateComponent[];
};

const LANG_PREFER = ['en', 'en_GB', 'en_US', 'en_IN'];
const BLOCKED_TEMPLATE_STATUS = new Set([
  'PENDING',
  'REJECTED',
  'DISABLED',
  'PAUSED',
  'PENDING_DELETION',
  'DELETED',
  'IN_APPEAL',
]);

export function findAdminWaTemplate(id: string) {
  const key = id.trim();
  return ADMIN_WA_TEMPLATES.find((item) => item.id === key) ?? null;
}

function templateLanguage(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && 'code' in raw) return String((raw as { code?: unknown }).code ?? '').trim();
  return '';
}

/** Manager shows these as Active. The list API sometimes omits status or says ACTIVE instead of APPROVED. */
export function templateCanBeSent(status: string | undefined): boolean {
  const value = String(status ?? '').trim().toUpperCase();
  if (!value || value === 'APPROVED' || value === 'ACTIVE' || value.startsWith('ACTIVE')) return true;
  return !BLOCKED_TEMPLATE_STATUS.has(value);
}

export function normalizeMetaTemplates(rows: unknown[]): MetaTemplateDefinition[] {
  const out: MetaTemplateDefinition[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const name = String(row.name ?? '').trim();
    if (!name) continue;
    out.push({
      name,
      status: String(row.status ?? '').trim(),
      language: templateLanguage(row.language),
      components: Array.isArray(row.components) ? (row.components as MetaTemplateComponent[]) : [],
    });
  }
  return out;
}

export function pickApprovedTemplate(
  rows: MetaTemplateDefinition[],
  metaName: string,
): MetaTemplateDefinition | null {
  const want = metaName.trim().toLowerCase();
  const approved = rows.filter(
    (row) => (row.name ?? '').trim().toLowerCase() === want && templateCanBeSent(row.status),
  );
  for (const code of LANG_PREFER) {
    const hit = approved.find((row) => row.language === code);
    if (hit) return hit;
  }
  return approved[0] ?? null;
}

/** Used when the template list does not come back. Sending still uses the approved name. */
export function fallbackAdminTemplate(metaName: string): MetaTemplateDefinition {
  if (metaName === 'application_kyc') {
    return {
      name: metaName,
      status: 'APPROVED',
      language: 'en_GB',
      components: [
        {
          type: 'BODY',
          text: 'Dear {{1}}. Your account application is in progress. KYC verification is pending. Complete it in just 2 mins',
        },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Complete KYC' },
            { type: 'QUICK_REPLY', text: 'Check Application Status' },
          ],
        },
      ],
    };
  }
  return {
    name: metaName,
    status: 'APPROVED',
    language: 'en',
    components: [{ type: 'BODY', text: 'Namaste {{1}} ji' }],
  };
}

export function templateLanguageOrder(metaName: string, listed?: string): string[] {
  const preferred = metaName === 'application_kyc' ? ['en_GB', 'en', 'en_US'] : ['en', 'en_US', 'en_GB', 'en_IN'];
  const first = String(listed ?? '').trim();
  return [...new Set(first ? [first, ...preferred] : preferred)];
}

export function isTemplateLanguageMiss(error?: string): boolean {
  return /132001|does not exist in the translation|template name .* does not exist/i.test(error || '');
}

function placeholderCount(text: string): number | null {
  const found = new Set<number>();
  for (const match of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) found.add(Number(match[1]));
  const indexes = [...found].sort((a, b) => a - b);
  if (indexes.some((value, index) => value !== index + 1)) return null;
  return indexes.length;
}

function fill(text: string, name: string): string {
  return text.replace(/\{\{\s*\d+\s*\}\}/g, name);
}

function textParams(count: number, name: string): { type: 'text'; text: string }[] {
  return Array.from({ length: count }, () => ({ type: 'text' as const, text: name }));
}

export function buildAdminTemplateSend(
  phone: string,
  template: MetaTemplateDefinition,
  customerName: string,
): { payload: Record<string, unknown>; text: string; buttons: string[] } | { error: string } {
  const name = template.name?.trim();
  const language = template.language?.trim();
  if (!name || !language) return { error: 'WhatsApp did not return this template.' };
  const components = Array.isArray(template.components) ? template.components : [];
  const header = components.find((item) => String(item.type ?? '').toUpperCase() === 'HEADER');
  const body = components.find((item) => String(item.type ?? '').toUpperCase() === 'BODY');
  const footer = components.find((item) => String(item.type ?? '').toUpperCase() === 'FOOTER');
  const buttonBlock = components.find((item) => String(item.type ?? '').toUpperCase() === 'BUTTONS');

  const headerFormat = String(header?.format ?? 'TEXT').toUpperCase();
  if (header && headerFormat !== 'TEXT') {
    return { error: 'This template needs a photo or file in the header, so it cannot be sent from this menu.' };
  }

  const graphComponents: Record<string, unknown>[] = [];
  const headerText = String(header?.text ?? '');
  if (headerText) {
    const count = placeholderCount(headerText);
    if (count == null) return { error: 'This template has a blank we cannot fill.' };
    if (count > 0) graphComponents.push({ type: 'header', parameters: textParams(count, customerName) });
  }

  const bodyText = String(body?.text ?? '');
  if (!bodyText.trim()) return { error: 'This template has no message text.' };
  const bodyCount = placeholderCount(bodyText);
  if (bodyCount == null) return { error: 'This template has a blank we cannot fill.' };
  if (bodyCount > 0) graphComponents.push({ type: 'body', parameters: textParams(bodyCount, customerName) });

  const footerText = String(footer?.text ?? '');
  if (placeholderCount(footerText) == null || (placeholderCount(footerText) ?? 0) > 0) {
    return { error: 'This template has a blank we cannot fill.' };
  }

  const labels: string[] = [];
  for (const button of buttonBlock?.buttons ?? []) {
    const type = String(button.type ?? '').toUpperCase();
    const label = String(button.text ?? '').trim();
    if (type === 'URL' && /\{\{\s*\d+\s*\}\}/.test(String(button.url ?? ''))) {
      return { error: 'This template button needs a link, so it cannot be sent from this menu.' };
    }
    if (type !== 'QUICK_REPLY' && type !== 'URL' && type !== 'PHONE_NUMBER') {
      return { error: 'This template has a button type this menu cannot send.' };
    }
    if (label) labels.push(label.slice(0, 40));
  }

  const text = [headerText, bodyText, footerText]
    .map((part) => fill(part, customerName).trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4000);

  return {
    text,
    buttons: labels.slice(0, 3),
    payload: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name,
        language: { code: language },
        ...(graphComponents.length ? { components: graphComponents } : {}),
      },
    },
  };
}
