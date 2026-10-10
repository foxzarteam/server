const SITE = 'https://apnizaroorat.com';
const LOAN_URL = `${SITE}/products/personal-loan/`;
const INSURANCE_URL = `${SITE}/products/insurance/`;
const STATUS_URL = `${SITE}/customer/login/`;
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
  return `Great, ${who(profileName)}! 💰\n\nAapke liye bilkul affordable EMI par Personal Loan ke best options available hain.\n\nApni loan eligibility jaanne ke liye abhi apply karein 👇\n${LOAN_URL}`;
}

export function insuranceText(profileName: string): string {
  return `Great, ${who(profileName)}! 🛡️\n\nAapke liye affordable plans par Health, Bike, Life aur har tarah ke insurance options available hain.\n\nApni zaroorat ke hisaab se insurance ke liye abhi apply karein 👇\n${INSURANCE_URL}`;
}

export function productImageUrl(choice: ProductChoice): string {
  return choice === 'insurance' ? INSURANCE_IMAGE : LOAN_IMAGE;
}

export function productImageFilename(choice: ProductChoice): string {
  return choice === 'insurance' ? 'wa_ins.jpg' : 'wa_loa.jpg';
}

type ProductImageFields = {
  kind?: string;
  waType?: string;
  filename?: string;
  mediaId?: string;
  mediaUrl?: string;
  mime?: string;
};

export function productImageFile(message: { filename?: string; kind?: string }): 'wa_loa.jpg' | 'wa_ins.jpg' | '' {
  if (message.filename === 'wa_ins.jpg' || message.filename === 'wa_loa.jpg') return message.filename;
  if (message.kind === 'insurance') return 'wa_ins.jpg';
  if (message.kind === 'personal_loan') return 'wa_loa.jpg';
  return '';
}

/** Cached Meta id if we already have one. Otherwise the public image link, so the reply is not waiting on an upload. */
export function withCachedProductImage<T extends ProductImageFields>(message: T, cachedMediaId: string): T {
  if (message.mediaId) return { ...message, waType: 'image', mediaUrl: undefined };
  const fileName = productImageFile(message);
  if (!fileName) {
    if (message.waType === 'image' && message.mediaUrl) return message;
    return message.waType === 'image' ? { ...message, waType: 'text' } : message;
  }
  const base = { ...message, filename: fileName, mime: 'image/jpeg', waType: 'image' as const };
  if (cachedMediaId) return { ...base, mediaId: cachedMediaId, mediaUrl: undefined };
  const choice: ProductChoice = fileName === 'wa_ins.jpg' ? 'insurance' : 'personal_loan';
  return { ...base, mediaId: undefined, mediaUrl: productImageUrl(choice) };
}

export function statusCheckText(): string {
  return [
    'Check your application status with your registered phone number. 📱✅',
    '',
    'click here 👇',
    STATUS_URL,
  ].join('\n');
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

export function thankYouText(profileName: string): string {
  return `Thank you, ${who(profileName)} 🙏\n\nAapka message hume mil gaya hai. Hamari team aapse jald hi contact karegi. Tab tak hamari website visit karein 👇\nhttps://apnizaroorat.com/`;
}

export function alreadyThanked(messages: { role: string; kind?: string }[]): boolean {
  return messages.some((item) => item.role === 'assistant' && item.kind === 'thanks');
}

export function alreadyOfferedProduct(messages: { role: string; kind?: string }[]): boolean {
  return messages.some(
    (item) => item.role === 'assistant' && (item.kind === 'personal_loan' || item.kind === 'insurance'),
  );
}

export function alreadyWelcomed(messages: { role: string; kind?: string; text: string }[]): boolean {
  return messages.some(
    (item) =>
      item.role === 'assistant' &&
      (item.kind === 'welcome' || /personal loan chahiye ya insurance/i.test(item.text)),
  );
}

export function alreadyKycStarted(messages: { role: string; kind?: string }[]): boolean {
  return messages.some((item) => item.role === 'assistant' && item.kind === 'kyc');
}

export function alreadyAdminMessaged(messages: { role: string; kind?: string }[]): boolean {
  return messages.some((item) => item.role === 'assistant' && item.kind === 'admin');
}

export function alreadyKycDocsAsked(messages: { role: string; kind?: string; sendError?: string }[]): boolean {
  return messages.some((item) => item.role === 'assistant' && item.kind === 'kyc_docs' && !item.sendError);
}

export function isKycStartClick(buttonId: string, text: string): boolean {
  const blob = `${buttonId} ${text}`.toLowerCase();
  return /kyc\s*start/.test(blob);
}

export function isKycStatusClick(buttonId: string, text: string): boolean {
  const blob = `${buttonId} ${text}`.toLowerCase();
  if (/kyc\s*start/.test(blob)) return false;
  return /application\s*status|status\s*check/.test(blob);
}

export function kycDocsRequestText(): string {
  return [
    'Great! 🎉',
    '',
    'Apni file aage badhane ke liye in 4 documents ki bilkul clear photo ya PDF isi chat me bhej dijiye:',
    '',
    '1️⃣ PAN Card 🪪',
    '2️⃣ Aadhaar Card 🆔',
    '3️⃣ Last 6 months bank statement 🏦',
    '4️⃣ Last 3 months salary slip 📄',
  ].join('\n');
}
