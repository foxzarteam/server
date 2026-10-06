const SITE = 'https://apnizaroorat.com';
const LOAN_URL = `${SITE}/products/personal-loan`;
const INSURANCE_URL = `${SITE}/products/insurance/`;
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
  return `Bahut accha choice, ${who(profileName)}! 🎉\nPersonal loan free me apply kijiye — paperless process, fast approval, aur kam EMI rate.\nAbhi apply karein:\n${LOAN_URL}`;
}

export function insuranceText(profileName: string): string {
  return `Great, ${who(profileName)}! 🛡️\nHealth, bike, life — sab tarah ke insurance options hamare paas hain. Paperless process, team aapki help karegi.\nAbhi apply karein:\n${INSURANCE_URL}`;
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
