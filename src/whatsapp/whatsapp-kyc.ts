import { productLabel } from '../leads/lead-present';

export const KYC_TEMPLATE = 'application_kyc';
export const KYC_TEMPLATE_LANG = 'en_GB';

export function kycBodyName(name: string): string {
  return name.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 200) || 'Customer';
}

export function kycProductName(category: string, insType?: string | null): string {
  return productLabel({ category, ins_type: insType });
}

export const KYC_START_BTN = 'Complete KYC';
export const KYC_STATUS_BTN = 'Check Application Status';

export function kycChatText(name: string, _category?: string, _insType?: string | null): string {
  const who = kycBodyName(name);
  return `Dear ${who}. Your account application is in progress. KYC verification is pending. Complete it in just 2 mins`;
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
