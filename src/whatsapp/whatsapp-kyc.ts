import { productLabel } from '../leads/lead-present';
import type { MetaTemplateDefinition } from './whatsapp-admin-templates';

export const KYC_TEMPLATE = 'kyc_application';
export const KYC_TEMPLATE_LANG = 'en_GB';
export const KYC_TEMPLATE_ID = '3762103050596977';

export function isLoanKycMessageId(id: string): boolean {
  const value = String(id ?? '');
  return (
    value.startsWith('kyc:') ||
    value.startsWith('tpl:application_kyc:') ||
    value.startsWith(`tpl:${KYC_TEMPLATE}:`)
  );
}

/** The 2-button application KYC already reached Meta for this chat. */
export function kycTemplateAlreadySent(
  messages: { id?: string; sent?: boolean; sendError?: string; waMessageId?: string }[],
): boolean {
  return messages.some((item) => {
    const id = String(item.id ?? '');
    if (!isLoanKycMessageId(id)) return false;
    if (item.sendError) return false;
    return item.sent === true || Boolean(item.waMessageId);
  });
}

export function kycBodyName(name: string): string {
  return name.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 200) || 'Customer';
}

export function kycProductName(category: string, insType?: string | null): string {
  return productLabel({ category, ins_type: insType });
}

export const KYC_START_BTN = 'Complete KYC';
export const KYC_STATUS_BTN = 'Check Application Status';

export function kycChatText(name: string, _category?: string, _insType?: string | null): string {
  return `Dear ${kycBodyName(name)},`;
}

function fillPositional(text: string, values: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, raw: string) => {
    const index = Number(raw) - 1;
    return values[index] ?? '';
  });
}

/** Graph payload + inbox text from Meta template id 3762103050596977 (`kyc_application`). */
export function buildApplicationKycSend(
  phone: string,
  template: MetaTemplateDefinition,
  name: string,
  languageOverride?: string,
): { payload: Record<string, unknown>; text: string } | { error: string } {
  const templateName = String(template.name ?? '').trim();
  const language = String(languageOverride || template.language || KYC_TEMPLATE_LANG).trim();
  if (!templateName || !language) return { error: 'WhatsApp did not return this template.' };
  if (templateName !== KYC_TEMPLATE) {
    return { error: `Expected template ${KYC_TEMPLATE}, got ${templateName}.` };
  }
  const components = Array.isArray(template.components) ? template.components : [];
  const body = components.find((item) => String(item.type ?? '').toUpperCase() === 'BODY');
  const bodyText = String(body?.text ?? '').trim();
  if (!bodyText) return { error: 'This template has no message text.' };
  const who = kycBodyName(name);
  const text = fillPositional(bodyText, [who]).slice(0, 4000);
  return {
    text,
    payload: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: who }],
          },
        ],
      },
    },
  };
}

export function kycGraphPayload(
  phone: string,
  name: string,
  _category: string,
  lang: string,
  _insType?: string | null,
): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: KYC_TEMPLATE,
      language: { code: lang },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: kycBodyName(name) }],
        },
      ],
    },
  };
}
