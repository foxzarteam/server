import { creditCardKindLabel } from '../leads/credit-card-profile';
import { insTypeLabel } from '../leads/lead-present';
import type { MetaTemplateDefinition } from './whatsapp-admin-templates';
import { kycBodyName } from './whatsapp-kyc';

/** Meta template names (must match WhatsApp Manager). Body is loaded by template id. */
export const CREDIT_CARD_SUBMIT_TEMPLATE = 'fd_credit_card_request';
export const INSURANCE_SUBMIT_TEMPLATE = 'insurance_application';
export const APPLY_CONFIRM_TEMPLATE_LANG = 'en';

export function applyConfirmChatId(category: 'credit_card' | 'insurance', phone: string): string {
  return `apply_confirm:${category}:${phone}`;
}

export function applyConfirmAlreadySent(
  messages: { id?: string; sent?: boolean; sendError?: string; waMessageId?: string }[],
  category: 'credit_card' | 'insurance',
  phone: string,
): boolean {
  const want = applyConfirmChatId(category, phone);
  return messages.some((item) => {
    if (String(item.id ?? '') !== want) return false;
    if (item.sendError) return false;
    return item.sent === true || Boolean(item.waMessageId);
  });
}

export function applyConfirmTemplateName(
  category: 'credit_card' | 'insurance',
  _creditCardKind?: string | null,
): string {
  if (category === 'insurance') return INSURANCE_SUBMIT_TEMPLATE;
  return CREDIT_CARD_SUBMIT_TEMPLATE;
}

/** Credit card → {{1}}=name, {{2}}=FD Credit Card | Normal Credit Card. Insurance → {{1}}=name, {{2}}=type. */
export function applyConfirmBodyValues(
  category: 'credit_card' | 'insurance',
  name: string,
  insType?: string | null,
  creditCardKind?: string | null,
): string[] {
  const who = kycBodyName(name);
  if (category === 'credit_card') {
    const card = creditCardKindLabel(creditCardKind) || 'Credit Card';
    return [who, card];
  }
  const product = insTypeLabel(insType).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
  return [who, product || 'Insurance'];
}

function fillPositional(text: string, values: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, raw: string) => {
    const index = Number(raw) - 1;
    return values[index] ?? '';
  });
}

function bodyParamCount(text: string): number {
  const found = new Set<number>();
  for (const match of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) found.add(Number(match[1]));
  return found.size;
}

/**
 * Build Graph payload + inbox bubble text from Meta template definition (body from template id).
 */
export function buildApplyConfirmSend(
  phone: string,
  template: MetaTemplateDefinition,
  category: 'credit_card' | 'insurance',
  name: string,
  insType?: string | null,
  languageOverride?: string,
  creditCardKind?: string | null,
): { payload: Record<string, unknown>; text: string } | { error: string } {
  const templateName = String(template.name ?? '').trim();
  const language = String(languageOverride || template.language || APPLY_CONFIRM_TEMPLATE_LANG).trim();
  if (!templateName || !language) return { error: 'WhatsApp did not return this template.' };

  const wantName = applyConfirmTemplateName(category, creditCardKind);
  if (templateName !== wantName) {
    return { error: `Expected template ${wantName}, got ${templateName}.` };
  }

  const components = Array.isArray(template.components) ? template.components : [];
  const body = components.find((item) => String(item.type ?? '').toUpperCase() === 'BODY');
  const bodyText = String(body?.text ?? '').trim();
  if (!bodyText) return { error: 'This template has no message text.' };

  const count = bodyParamCount(bodyText);
  const values = applyConfirmBodyValues(category, name, insType, creditCardKind);
  if (category === 'credit_card' && count !== 2) {
    return { error: 'Credit card template must have exactly 2 body variables (name and card type).' };
  }
  if (category === 'insurance' && count !== 2) {
    return { error: 'Insurance template must have exactly 2 body variables.' };
  }

  const parameters = values.slice(0, count).map((text) => ({ type: 'text' as const, text }));
  const text = fillPositional(bodyText, values).slice(0, 4000);

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
        ...(count > 0 ? { components: [{ type: 'body', parameters }] } : {}),
      },
    },
  };
}

/** Fallback bubble if Meta template fetch fails (send still uses approved template name). */
export function applyConfirmFallbackText(
  category: 'credit_card' | 'insurance',
  name: string,
  insType?: string | null,
  creditCardKind?: string | null,
): string {
  const [who, product] = applyConfirmBodyValues(category, name, insType, creditCardKind);
  if (category === 'credit_card') {
    return [
      `Hello ${who} Ji,`,
      '',
      `Your ${product} application request has been received by Apni Zaroorat.`,
      '',
      'To proceed with your application, please share clear photos of:',
      '',
      '1. PAN Card',
      '2. Aadhaar Card',
      '',
      'We will contact you shortly.',
      '',
      'Team Apni Zaroorat',
    ].join('\n');
  }
  return [
    `🎉 Hello ${who} Ji`,
    '',
    `✅ Your ${product} application has been successfully submitted.`,
    '',
    '📩 Our team will update you regarding the next steps shortly.',
    '',
    '🙏 Thank you for choosing Apni Zaroorat! 😊',
  ].join('\n');
}
