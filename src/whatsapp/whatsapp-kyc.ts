import { normalizeStoredCategory } from '../leads/lead-present';

export const KYC_TEMPLATE = 'application_kyc_start';
export const KYC_TEMPLATE_LANGS = ['en_GB', 'en'] as const;

export function kycBodyName(name: string): string {
  return name.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 200) || 'Customer';
}

export function kycProductName(category: string): string {
  return normalizeStoredCategory(category) === 'insurance' ? 'Insurance' : 'Personal Loan';
}

export function kycGraphPayload(phone: string, name: string, category: string, lang: string): Record<string, unknown> {
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
          parameters: [
            { type: 'text', text: kycBodyName(name) },
            { type: 'text', text: kycProductName(category) },
          ],
        },
      ],
    },
  };
}
