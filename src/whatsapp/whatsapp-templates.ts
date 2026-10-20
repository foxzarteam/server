const SITE = 'https://apnizaroorat.com';
const LOAN_URL = `${SITE}/products/loans/`;
const INSURANCE_URL = `${SITE}/products/insurance/`;
const STATUS_URL = `${SITE}/customer/login`;
const LOAN_IMAGE = `${SITE}/images/whatsapp/wa_loa.jpg`;
const INSURANCE_IMAGE = `${SITE}/images/whatsapp/wa_ins.jpg`;
const BTN_LOAN = 'personal_loan';
const BTN_INSURANCE = 'insurance';

export type ProductChoice = 'personal_loan' | 'insurance';

function who(profileName: string): string {
  const name = profileName.trim();
  return name || 'there';
}

export function welcomeText(profileName: string): string {
  return `Hello ${who(profileName)} 🙏\nWelcome to Apni Zaroorat.\nTell us, do you need a Loan or Insurance?\nTap a button below.`;
}

export function personalLoanText(profileName: string): string {
  return `Great, ${who(profileName)}! 💰\n\nThe best loan options are available for you at a very affordable EMI.\n\nApply now to check your loan eligibility 👇\n${LOAN_URL}`;
}

export function insuranceText(profileName: string): string {
  return `Great, ${who(profileName)}! 🛡️\n\nHealth, Bike, Life, and every kind of insurance option is available for you on affordable plans.\n\nApply now for the insurance that fits your needs 👇\n${INSURANCE_URL}`;
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
          { type: 'reply', reply: { id: BTN_LOAN, title: 'Loan' } },
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

export function alreadyThanked(messages: { role: string; kind?: string }[]): boolean {
  return messages.some((item) => item.role === 'assistant' && item.kind === 'thanks');
}

/** Sent once for good. One failed attempt can be retried. Two failures stop, so it does not loop. */
export function templateSettled(
  messages: { role: string; kind?: string; sendError?: string }[],
  kind: string,
): boolean {
  const hits = messages.filter((item) => item.role === 'assistant' && item.kind === kind);
  if (hits.some((item) => !item.sendError)) return true;
  return hits.filter((item) => item.sendError).length >= 2;
}

export function alreadyOfferedProduct(messages: { role: string; kind?: string; sendError?: string }[]): boolean {
  return templateSettled(messages, 'personal_loan') || templateSettled(messages, 'insurance');
}

export function alreadyWelcomed(messages: { role: string; kind?: string; text: string; sendError?: string }[]): boolean {
  if (templateSettled(messages, 'welcome')) return true;
  const hits = messages.filter(
    (item) =>
      item.role === 'assistant' &&
      /loan chahiye ya insurance|do you need a loan or insurance/i.test(item.text),
  );
  if (hits.some((item) => !item.sendError)) return true;
  return hits.filter((item) => item.sendError).length >= 2;
}

export function alreadyKycStarted(messages: { role: string; kind?: string; text?: string }[]): boolean {
  return messages.some((item) => {
    if (item.role !== 'assistant') return false;
    if (item.kind === 'kyc' || item.kind === 'kyc_docs') return true;
    return /kyc verification is pending|account application is in progress|complete your kyc|in just 2 mins/i.test(
      item.text || '',
    );
  });
}

export function alreadyAdminMessaged(messages: { role: string; kind?: string }[]): boolean {
  return messages.some((item) => item.role === 'assistant' && item.kind === 'admin');
}

export function alreadyStatusSent(messages: { role: string; kind?: string; sendError?: string }[]): boolean {
  return templateSettled(messages, 'status');
}

export function alreadyKycDocsAsked(messages: { role: string; kind?: string; sendError?: string }[]): boolean {
  return templateSettled(messages, 'kyc_docs');
}

export function isKycStartClick(buttonId: string, text: string): boolean {
  const blob = `${buttonId} ${text}`.toLowerCase();
  return /kyc[\s_-]*start|start[\s_-]*kyc|complete[\s_-]*kyc/.test(blob);
}

export function isKycStatusClick(buttonId: string, text: string): boolean {
  const blob = `${buttonId} ${text}`.toLowerCase();
  if (/kyc[\s_-]*start|start[\s_-]*kyc|complete[\s_-]*kyc/.test(blob)) return false;
  return /application\s*status|status\s*check/.test(blob);
}

export function underReviewText(): string {
  return [
    'We have successfully received your KYC documents. ✅',
    '',
    'Your application is under review. We will update you soon. 🙏',
  ].join('\n');
}

/** Gentle note when an admin marks an application not approved. Sent once per phone. */
export function rejectedText(): string {
  return [
    'Thank you for applying with Apni Zaroorat. 🙏',
    '',
    'Sorry, your loan application could not be approved as it did not meet eligibility criteria.',
  ].join('\n');
}

function kycDocsIntro(): string {
  return 'To complete your KYC, please share clear photos or PDFs of these documents:';
}

/** Salaried applicants. Default when employment is missing. */
export function kycDocsRequestText(employment?: string | null): string {
  const kind = String(employment ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (kind === 'self_employed' || kind === 'selfemployed') {
    return [
      kycDocsIntro(),
      '',
      '1️⃣ PAN Card 🪪',
      '2️⃣ Aadhaar Card 🆔',
      '3️⃣ Last 12 Months’ Bank Statement (PDF) 🏦',
      '4️⃣ Last 3 Years’ ITR with Computation 📄',
      '5️⃣ Any Available Business Proof (GST / Udyam / Shop Licence) 🏪',
      '6️⃣ Passport-Size Photo 📸',
    ].join('\n');
  }
  return [
    kycDocsIntro(),
    '',
    '1️⃣ PAN Card 🪪',
    '2️⃣ Aadhaar Card 🆔',
    '3️⃣ Last 6 Months’ Bank Statement 🏦',
    '4️⃣ Last 3 Months’ Salary Slips 📄',
    '5️⃣ Passport-Size Photo 📸',
  ].join('\n');
}
