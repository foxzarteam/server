/** Admin inbox menu. Same names are approved on Meta. Admin can send each one again. */
export const ADMIN_WA_TEMPLATES = [
  { id: 'vehicle_refinance_kyc', label: 'Loan on Existing Car (Refinance)', metaName: 'vehicle_refinance_kyc', kyc: true },
  { id: 'vehicle_purchase_kyc', label: 'New / Used Car Loan (Purchase)', metaName: 'vehicle_purchase_kyc', kyc: true },
  { id: 'personal_loan_kyc', label: 'Personal Loan (PL KYC)', metaName: 'personal_loan_kyc', kyc: true },
  { id: 'self_employed_kyc', label: 'Self employee KYC', metaName: 'self_employed_kyc', kyc: true },
  { id: 'document_pending_reminder', label: 'Reminder: Documents Pending', metaName: 'document_pending_reminder', kyc: false },
  { id: 'call_not_answered_followup', label: 'Reminder: Call Not Answered', metaName: 'call_not_answered_followup', kyc: false },
  { id: 'reject_template', label: 'Reject Application', metaName: 'reject_template', kyc: false },
] as const;

export type AdminWaTemplateId = (typeof ADMIN_WA_TEMPLATES)[number]['id'];

/** Meta template node id. Message text is read from this id, not stored in code. */
const TEMPLATE_META_IDS: Record<AdminWaTemplateId | 'application_kyc', string> = {
  application_kyc: '2014497809484610',
  vehicle_refinance_kyc: '1701000475154093',
  vehicle_purchase_kyc: '2020701738620974',
  personal_loan_kyc: '29218275084524752',
  self_employed_kyc: '1143750884876894',
  document_pending_reminder: '2268054780795382',
  call_not_answered_followup: '1429874262035888',
  reject_template: '2397652557726837',
};

export function templateMetaId(metaName: string): string {
  return TEMPLATE_META_IDS[metaName as keyof typeof TEMPLATE_META_IDS] ?? '';
}

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

const FAKE_PERSON_NAME = /^(customer|whatsapp user|user|there|unknown)$/i;

/** Application form name first. WhatsApp profile name only when the form has no real name. Never "Customer". */
export function templatePersonName(formName: string, profileName: string): string {
  const clean = (value: string) => value.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
  const form = clean(formName);
  if (form && !FAKE_PERSON_NAME.test(form)) return form;
  const profile = clean(profileName);
  if (profile && !FAKE_PERSON_NAME.test(profile)) return profile;
  return '';
}

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

function nameFromShortTemplate(stored: string): string {
  const namaste = stored.match(/^Namaste\s+(.+?)\s+ji[,.]?$/i);
  if (namaste?.[1]) return namaste[1].trim();
  const dear = stored.match(/^Dear\s+(.+?)\.?$/i);
  if (dear?.[1]) return dear[1].trim();
  return '';
}

/** Template name when this bubble is only the old one-line greeting and Meta can fill the rest. */
export function liveTemplateKey(messageId: string, storedText: string): string {
  const templateId = /^tpl:([a-z0-9_]+):/i.exec(messageId)?.[1] ?? '';
  if (!templateId || !templateMetaId(templateId) || !nameFromShortTemplate(String(storedText ?? '').trim())) return '';
  return templateId;
}

/** Fill a short saved greeting with the body Meta returned for that template. */
export function adminBubbleText(
  messageId: string,
  storedText: string,
  template: MetaTemplateDefinition | null,
): string {
  const stored = String(storedText ?? '');
  const templateId = liveTemplateKey(messageId, stored);
  if (!templateId || !template || (template.name ?? '').trim() !== templateId) return stored;
  const name = nameFromShortTemplate(stored.trim());
  if (!name) return stored;
  const built = buildAdminTemplateSend('1000000000', template, name);
  if ('error' in built || stored.trim().length >= built.text.length) return stored;
  return built.text;
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
