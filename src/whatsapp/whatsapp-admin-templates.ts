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

const LANG_PREFER = ['en_GB', 'en', 'en_US', 'en_IN'];

export function findAdminWaTemplate(id: string) {
  const key = id.trim();
  return ADMIN_WA_TEMPLATES.find((item) => item.id === key) ?? null;
}

export function pickApprovedTemplate(
  rows: MetaTemplateDefinition[],
  metaName: string,
): MetaTemplateDefinition | null {
  const approved = rows.filter(
    (row) => row.name === metaName && String(row.status ?? '').toUpperCase() === 'APPROVED',
  );
  for (const code of LANG_PREFER) {
    const hit = approved.find((row) => row.language === code);
    if (hit) return hit;
  }
  return approved[0] ?? null;
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
