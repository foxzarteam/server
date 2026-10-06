const SITE = 'https://apnizaroorat.com';
const LOAN_URL = `${SITE}/products/personal-loan/`;
const INSURANCE_URL = `${SITE}/products/insurance/`;
const LOAN_IMAGE = `${SITE}/images/whatsapp/wa_loa.jpg`;
const INSURANCE_IMAGE = `${SITE}/images/whatsapp/wa_ins.jpg`;
const BTN_LOAN = 'personal_loan';
const BTN_INSURANCE = 'insurance';

export type ProductChoice = 'personal_loan' | 'insurance';

function who(profileName: string): string {
  const name = profileName.trim();
  return name ? `${name} ji` : 'ji';
}

export function welcomeText(profileName: string): string {
  return `Namaste ${who(profileName)} 🙏\nApni Zaroorat me aapka swagat hai.\nBataiye, aapko Personal Loan chahiye ya Insurance?\nNeeche button pe tap kijiye.`;
}

export function personalLoanText(profileName: string): string {
  return `Great, ${who(profileName)}! 💰\nAapke liye bilkul affordable EMI par Personal Loan ke best options available hain.\nApni loan eligibility jaanne ke liye abhi apply karein 👇\n${LOAN_URL}`;
}

export function insuranceText(profileName: string): string {
  return `Great, ${who(profileName)}! 🛡️\nAapke liye affordable plans par Health, Bike, Life aur har tarah ke insurance options available hain.\nApni zaroorat ke hisaab se insurance ke liye abhi apply karein 👇\n${INSURANCE_URL}`;
}

export function productImageUrl(choice: ProductChoice): string {
  return choice === 'insurance' ? INSURANCE_IMAGE : LOAN_IMAGE;
}

export function productImageFilename(choice: ProductChoice): string {
  return choice === 'insurance' ? 'wa_ins.jpg' : 'wa_loa.jpg';
}

export function welcomeInteractive(body: string) {
  return {
    type: 'interactive' as const,
    interactive: {
      type: 'button',
      body: { text: body.slice(0, 1024) },
      action: {
        buttons: [
          { type: 'reply', reply: { id: BTN_LOAN, title: 'Personal Loan' } },
          { type: 'reply', reply: { id: BTN_INSURANCE, title: 'Insurance' } },
        ],
      },
    },
  };
}

export function productChoice(buttonId: string, text: string): ProductChoice | '' {
  const id = buttonId.trim().toLowerCase();
  if (id === BTN_LOAN) return 'personal_loan';
  if (id === BTN_INSURANCE) return 'insurance';
  const t = text.trim().toLowerCase();
  if (!t) return '';
  if (/\binsurance|insurence|insurnace\b/.test(t) && !/\bloan\b/.test(t)) return 'insurance';
  if (/\bpersonal loan\b/.test(t) || t === 'loan') return 'personal_loan';
  return '';
}

export function alreadyWelcomed(messages: { role: string; kind?: string; text: string }[]): boolean {
  return messages.some(
    (item) =>
      item.role === 'assistant' &&
      (item.kind === 'welcome' || /personal loan chahiye ya insurance/i.test(item.text)),
  );
}
