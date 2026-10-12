import { productLabel } from '../leads/lead-present';

export const KYC_TEMPLATE = 'application_kyc';
export const KYC_TEMPLATE_LANG = 'en_GB';

export function kycBodyName(name: string): string {
  return name.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 200) || 'Customer';
}

export function kycProductName(category: string, insType?: string | null): string {
  return productLabel({ category, ins_type: insType });
}

export const KYC_START_BTN = 'Haan, KYC Start Karein';
export const KYC_STATUS_BTN = 'Application Status Check Karein';

export function kycChatText(name: string, category: string, insType?: string | null): string {
  const who = kycBodyName(name);
  const product = kycProductName(category, insType);
  return `Hello ${who}! Apni Zaroorat par details dene ke liye shukriya. Aapki ${product} file ke liye KYC start karein.`;
}

export function kycGraphPayload(
  phone: string,
  name: string,
  category: string,
  lang: string,
  insType?: string | null,
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
          parameters: [
            { type: 'text', text: kycBodyName(name) },
            { type: 'text', text: kycProductName(category, insType) },
          ],
        },
      ],
    },
  };
}
