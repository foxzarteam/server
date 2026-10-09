import {
  isKycStartClick,
  isKycStatusClick,
  productChoice,
  type ProductChoice,
} from './whatsapp-templates';

export type BotReplyKind =
  | 'kyc_docs'
  | 'status'
  | 'personal_loan'
  | 'insurance'
  | 'welcome'
  | 'thanks';

export type BotState = {
  kyc: boolean;
  kycDocs: boolean;
  welcomed: boolean;
  offered: boolean;
  thanked: boolean;
  product?: ProductChoice;
};

/** First inbound like Hello / Hi / Namaste → welcome buttons. */
export function isGreeting(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 40) return false;
  return /^(hi|hii|hiii|hello|helo|hey|heyy|namaste|namaskar|yo|hola|hlw|hlo|good morning|good evening|good afternoon)(\s|$)/.test(
    t,
  );
}

/**
 * One place for WhatsApp bot replies.
 * 1. KYC Start click → docs list (once)
 * 2. Status check click → login link
 * 3. Personal Loan / Insurance tap or words → product
 * 4. Hello/Hi/Namaste → Namaste welcome — never if KYC template already went
 * 5. Other text after welcome, no product yet → thank you once
 * 6. After product / thanks / KYC, other chatter → silent
 */
export function pickBotReply(
  buttonId: string,
  text: string,
  state: BotState,
): { kind: BotReplyKind; product?: ProductChoice } | { kind: null } {
  if (isKycStartClick(buttonId, text)) {
    if (state.kycDocs) return { kind: null };
    return { kind: 'kyc_docs' };
  }
  if (isKycStatusClick(buttonId, text)) return { kind: 'status' };

  const choice = productChoice(buttonId, text);
  if (choice === 'personal_loan' || choice === 'insurance') {
    if (state.product === choice) return { kind: null };
    return { kind: choice, product: choice };
  }

  if (state.kyc) return { kind: null };

  if (isGreeting(text)) {
    if (state.welcomed) return { kind: null };
    return { kind: 'welcome' };
  }

  if (state.offered || state.thanked) return { kind: null };
  if (state.welcomed) {
    if (state.offered || state.thanked) return { kind: null };
    return { kind: 'thanks' };
  }
  return { kind: 'welcome' };
}
