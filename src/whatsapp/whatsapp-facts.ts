export type ChatFacts = {
  product?: 'personal_loan' | 'insurance';
  insType?: string;
  name?: string;
  pincode?: string;
  city?: string;
  employment?: 'salaried' | 'business';
  income?: string;
  loanAmount?: string;
  tenureMonths?: string;
  pan?: string;
  insDetail?: string;
};

const SKIP_NAMES = /^(hi|hii|hello|hey|ok|okay|haan|han|yes|no|na|ji|sir|mam|loan|insurance|personal|thanks|thankyou|namaste)$/i;
const ABUSE = /\b(dog|kutta|gandu|chutiya|madarchod|bhosd|randi|idiot|stupid|fuck|shit)\b|you are (a )?(dog|idiot|stupid)|\bmc\b|\bbc\b/i;
const OFF_TOPIC = /[?]|\b(emi|interest|rate|document|charges|fees|process|kaise|kab mil|kitne din|lakh pe|per lakh)\b|(pehle|pele).{0,24}(bta|bata|batao|bataiye|bol)/i;

export function parseChatFacts(raw: unknown): ChatFacts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const row = raw as Record<string, unknown>;
  const out: ChatFacts = {};
  const str = (key: keyof ChatFacts) => {
    const value = String(row[key] ?? '').trim();
    if (value) (out as Record<string, string>)[key] = value.slice(0, 80);
  };
  if (row.product === 'personal_loan' || row.product === 'insurance') out.product = row.product;
  if (row.employment === 'salaried' || row.employment === 'business') out.employment = row.employment;
  str('insType');
  str('name');
  str('pincode');
  str('city');
  str('income');
  str('loanAmount');
  str('tenureMonths');
  str('pan');
  str('insDetail');
  return sanitizeFacts(out);
}

function looksLikeName(text: string): string {
  const clean = text.replace(/[^\p{L}.\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || SKIP_NAMES.test(clean) || clean.length < 3 || clean.length > 60) return '';
  if (/\b(loan|insurance|pincode|salary|business|income|personal|emi|rate|kitna|pele|pehle)\b/i.test(clean)) return '';
  const words = clean.split(' ');
  if (words.length === 1 && words[0].length < 4) return '';
  if (words.length > 4) return '';
  return clean.replace(/(^|\s)\p{L}/gu, (letter) => letter.toUpperCase());
}

function looksLikeCity(text: string): string {
  if (isOffTopicText(text) || isAbuse(text)) return '';
  const city = text.replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = city.split(' ').filter(Boolean);
  if (words.length < 1 || words.length > 3) return '';
  if (city.length < 3 || city.length > 28) return '';
  if (SKIP_NAMES.test(city)) return '';
  if (/\b(emi|rate|loan|insurance|kitna|pele|pehle|bta|bata|tumhara|tumara|income|salary|pan|month|lakh)\b/i.test(city)) {
    return '';
  }
  return city.replace(/(^|\s)\p{L}/gu, (letter) => letter.toUpperCase());
}

function pincodeOf(text: string): string {
  const compact = text.replace(/\s/g, '');
  if (/^[1-9]\d{5}$/.test(compact)) return compact;
  if (text.trim().length > 24) return '';
  const match = compact.match(/([1-9]\d{5})/);
  return match ? match[1] : '';
}

function panOf(text: string): string {
  const match = text.toUpperCase().replace(/\s/g, '').match(/\b([A-Z]{5}[0-9]{4}[A-Z])\b/);
  return match ? match[1] : '';
}

function moneyOf(text: string): string {
  const lower = text.toLowerCase().replace(/,/g, '');
  const lakh = lower.match(/(\d+(?:\.\d+)?)\s*lakh/);
  if (lakh) return String(Math.round(Number(lakh[1]) * 100000));
  const k = lower.match(/(\d+)\s*k\b/);
  if (k) return String(Number(k[1]) * 1000);
  const rs = lower.match(/(?:₹|rs\.?|inr)?\s*(\d{4,7})\b/);
  if (rs) return rs[1];
  return '';
}

function tenureOf(text: string): string {
  const years = text.toLowerCase().match(/\b([1-6])\s*(?:year|yr|saal)\b/);
  if (years) return String(Number(years[1]) * 12);
  const withUnit = text.toLowerCase().match(/\b(1[2-9]|[2-6]\d|72)\s*(?:month|mahina|mahine)\b/);
  if (withUnit) return withUnit[1];
  const only = text.trim().match(/^(1[2-9]|[2-6]\d|72)$/);
  return only ? only[1] : '';
}

function productOf(text: string): ChatFacts['product'] {
  const t = text.toLowerCase();
  if (/\binsurance|health|bike|life cover|term plan\b/.test(t) && !/\bloan\b/.test(t)) return 'insurance';
  if (/\bloan|personal loan\b/.test(t)) return 'personal_loan';
  return undefined;
}

function employmentOf(text: string): ChatFacts['employment'] {
  const t = text.toLowerCase();
  if (/\bbusiness|self[- ]?employ|apna kaam|dukan|shop\b/.test(t)) return 'business';
  if (/\bsalaried|salary|naukri|job|service|private job|govt\b/.test(t)) return 'salaried';
  return undefined;
}

function insTypeOf(text: string): string {
  const t = text.toLowerCase();
  if (/\bhealth\b/.test(t)) return 'health';
  if (/\bbike|two[- ]wheeler\b/.test(t)) return 'bike';
  if (/\bcar|motor|four[- ]wheeler\b/.test(t)) return 'car';
  if (/\blife\b/.test(t)) return 'life';
  if (/\btravel\b/.test(t)) return 'travel';
  if (/\baccident\b/.test(t)) return 'personal accident';
  return '';
}

function askedField(ask: string): string {
  const t = ask.toLowerCase();
  if (/personal loan chahiye ya insurance|loan chahiye ya insurance/.test(t)) return 'product';
  if (/pincode|pin code|\bshehar\b|\bcity\b|\barea\b/.test(t)) return 'pincode';
  if (/self or family|vehicle|age range|kiske naam|short detail/.test(t)) return 'insDetail';
  if (/\bnaam\b|\bname\b|use karun/.test(t)) return 'name';
  if (/\bsalaried\b|\bbusiness\b|\bnaukri\b|\bjob\b/.test(t)) return 'employment';
  if (/\bincome\b|\bkamai\b|\bearn\b|in-hand|in hand/.test(t)) return 'income';
  if (/kitna loan|loan amount|kitna chahte|₹25,000|25000/.test(t)) return 'amount';
  if (/\btenure\b|kitne month/.test(t)) return 'tenure';
  if (/kis tarah ka insurance|insurance chahiye, jaise/.test(t)) return 'insType';
  if (/self or family|vehicle|age range|kiske naam|short detail/.test(t)) return 'insDetail';
  if (/\bpan\b/.test(t)) return 'pan';
  return '';
}

function applyAnswer(facts: ChatFacts, lastAsk: string, answer: string, profileName = ''): ChatFacts {
  const next = { ...facts };
  const text = answer.trim();
  if (!text || isOffTopicText(text) || isAbuse(text)) return next;

  const field = askedField(lastAsk);
  const pan = panOf(text);
  if (pan && (field === 'pan' || text.replace(/\s/g, '').toUpperCase() === pan)) next.pan = pan;

  if (field === 'product' || (!field && !next.product)) {
    const product = productOf(text);
    if (product) next.product = product;
  }

  if (field === 'pincode') {
    const pin = pincodeOf(text);
    if (pin) next.pincode = pin;
    else {
      const city = looksLikeCity(text);
      if (city) next.city = city;
    }
  }

  if (field === 'employment') {
    const job = employmentOf(text);
    if (job) next.employment = job;
  }

  if (field === 'insType') {
    const kind = insTypeOf(text);
    if (kind) next.insType = kind;
  }

  if (field === 'name') {
    if (/^(haan|han|yes|ok|okay|ji|yahi)$/i.test(text) && profileName.trim()) {
      next.name = looksLikeName(profileName) || profileName.trim();
    } else {
      const name = looksLikeName(text);
      if (name) next.name = name;
    }
  }

  if (field === 'income') {
    const money = moneyOf(text);
    if (money) next.income = money;
  }

  if (field === 'amount') {
    const money = moneyOf(text);
    const amount = Number(money);
    if (money && amount >= 25000 && amount <= 5_000_000) next.loanAmount = money;
  }

  if (field === 'tenure') {
    const months = tenureOf(text);
    if (months) next.tenureMonths = months;
  }

  if (field === 'insDetail' && !isOffTopicText(text)) {
    const detail = text.slice(0, 80);
    if (detail.length >= 2 && detail.length <= 40 && !/[?]/.test(detail)) next.insDetail = detail;
  }

  return sanitizeFacts(next);
}

function sanitizeFacts(facts: ChatFacts): ChatFacts {
  const out: ChatFacts = { ...facts };
  if (out.city && !looksLikeCity(out.city)) delete out.city;
  if (out.name && (isOffTopicText(out.name) || isAbuse(out.name))) delete out.name;
  if (out.pincode && !/^[1-9]\d{5}$/.test(out.pincode)) delete out.pincode;
  if (out.insDetail && (isOffTopicText(out.insDetail) || isAbuse(out.insDetail) || out.insDetail.split(' ').length > 8)) {
    delete out.insDetail;
  }
  const tenure = Number(out.tenureMonths);
  if (out.tenureMonths && (tenure < 12 || tenure > 72)) delete out.tenureMonths;
  return out;
}

export function isAbuse(text: string): boolean {
  return ABUSE.test(text.trim());
}

export function isOffTopicText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isAbuse(t)) return true;
  return OFF_TOPIC.test(t);
}

export function isGreeting(text: string): boolean {
  return /^(hi+|hii+|hello|hey|namaste|ok|okay|haan|han|ji)[\s!.]*$/i.test(text.trim());
}

export function nudgeSameField(facts: ChatFacts, profileName: string, greeted = true): string {
  const question = scriptedNavyaReply(facts, profileName, greeted, false) || 'Jo detail pending hai, woh sahi se bataiye.';
  return `Pehle apni detail share kariye. Hamari team aapki detail verify karke aapki eligibility ke hisaab se best option batayegi. Main yahi ke liye hoon. ${question}`;
}

export function collectChatFacts(
  saved: ChatFacts | undefined,
  messages: { role: string; text: string }[],
  profileName = '',
): ChatFacts {
  let facts = { ...parseChatFacts(saved) };
  let lastAsk = '';
  for (const item of messages) {
    const text = String(item.text ?? '').trim();
    if (!text) continue;
    if (item.role === 'assistant') {
      lastAsk = text;
      continue;
    }
    if (item.role === 'user') facts = applyAnswer(facts, lastAsk, text, profileName);
  }
  return sanitizeFacts(facts);
}

export function factsComplete(facts: ChatFacts): boolean {
  if (facts.product === 'personal_loan') {
    return Boolean(facts.name && (facts.pincode || facts.city) && facts.employment && facts.income && facts.loanAmount && facts.tenureMonths && facts.pan);
  }
  if (facts.product === 'insurance') {
    return Boolean(facts.insType && facts.name && (facts.pincode || facts.city) && facts.insDetail && facts.pan);
  }
  return false;
}

export function nextMissingField(facts: ChatFacts): string {
  if (!facts.product) return 'product';
  if (facts.product === 'personal_loan') {
    if (!facts.name) return 'name';
    if (!facts.pincode && !facts.city) return 'pincode';
    if (!facts.employment) return 'employment';
    if (!facts.income) return 'income';
    if (!facts.loanAmount) return 'amount';
    if (!facts.tenureMonths) return 'tenure';
    if (!facts.pan) return 'pan';
    return 'done';
  }
  if (!facts.insType) return 'insType';
  if (!facts.name) return 'name';
  if (!facts.pincode && !facts.city) return 'pincode';
  if (!facts.insDetail) return 'insDetail';
  if (!facts.pan) return 'pan';
  return 'done';
}

function who(facts: ChatFacts, profileName: string): string {
  const name = (facts.name || profileName).trim();
  return name ? `${name} ji` : 'ji';
}

function inr(value?: string): string {
  const n = Number(String(value || '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return String(value || '').trim();
  return n.toLocaleString('en-IN');
}

const CLOSED_MARK = /team isi WhatsApp number pe/i;

export function conversationClosed(messages: { role: string; text: string }[]): boolean {
  return messages.some((item) => item.role === 'assistant' && CLOSED_MARK.test(item.text));
}

export function closingReply(facts: ChatFacts, profileName: string, alreadyClosed = false): string {
  const ji = who(facts, profileName);
  if (alreadyClosed) {
    return `Aapki saari detail already mil chuki hai, ${ji}. Apni Zaroorat team isi WhatsApp number pe aapse contact karegi. Aap wait kijiye 🙏`;
  }
  return recapFacts(facts, profileName);
}

export function openingReply(profileName: string): string {
  const who = profileName.trim() ? `${profileName.trim()} ji` : 'ji';
  return `Namaste ${who}, aapka swagat hai 🙏 Main Navya baat kar rahi hoon Apni Zaroorat se. Pehle bataiye, aapko personal loan chahiye ya insurance? Aage main aapko check karke best option batati hoon.`;
}

export function scriptedNavyaReply(
  facts: ChatFacts,
  profileName: string,
  greeted = false,
  closed = false,
): string | null {
  const field = nextMissingField(facts);
  const ji = who(facts, profileName);
  if (field === 'done') return closingReply(facts, profileName, closed);
  if (field === 'product') {
    return greeted ? `Personal loan chahiye ya insurance? Ek baar bata dijiye.` : openingReply(profileName);
  }
  if (field === 'name') {
    const profile = profileName.trim();
    if (profile && !facts.name) {
      return `Great! WhatsApp pe naam ${profile} dikh raha hai. Yahi poora naam use karun, ya aap alag naam likh denge?`;
    }
    return `Great! Pehle aapka poora naam bataiye.`;
  }
  if (field === 'pincode') {
    return `Nice, ${ji}. Ab pincode ya shehar ka naam bataiye.`;
  }
  if (field === 'employment') {
    return `Shandar${facts.pincode ? `, ${facts.pincode}` : ''}. Aap salaried hain ya apna business chalate hain?`;
  }
  if (field === 'income') {
    return `Wow, noted. Mahine ka in-hand income approximate kitna hai?`;
  }
  if (field === 'amount') {
    return `Bahut accha. Aap kitna loan chahte hain? ₹25,000 se ₹50,00,000 ke beech bataiye.`;
  }
  if (field === 'tenure') {
    return `Great. Tenure kitne months chahiye, 12 se 72?`;
  }
  if (field === 'insType') {
    return `Hamare paas sab tarah ke insurance options hain 🛡️ Ek baar bataiye, aapko kis tarah ka insurance chahiye, jaise health, bike, life, ya jo bhi aapko chahiye?`;
  }
  if (field === 'insDetail') {
    const kind = (facts.insType || 'insurance').toLowerCase();
    if (kind.includes('health')) return `Nice. Yeh cover aapke liye hai ya family ke liye?`;
    if (kind.includes('bike') || kind.includes('car')) return `Nice. Vehicle kiske naam pe hai?`;
    if (kind.includes('life')) return `Nice. Age range roughly kya hai?`;
    return `Nice. Is cover ke baare mein ek short detail bataiye.`;
  }
  if (field === 'pan') {
    return `Last, poora PAN card number likh dijiye, jaise ABCDE1234F. Yeh sirf sahi person match karne ke liye hai.`;
  }
  return closingReply(facts, profileName, closed);
}

export function recapFacts(facts: ChatFacts, profileName: string): string {
  const ji = who(facts, profileName);
  const place = facts.pincode || looksLikeCity(facts.city || '') || '';
  if (facts.product === 'insurance') {
    const extra = facts.insDetail ? `, ${facts.insDetail}` : '';
    return `Thank you, ${ji} 🙏 Aapki saari detail mil gayi: ${facts.insType || 'insurance'}${extra}${place ? `, ${place}` : ''}. Main yeh Apni Zaroorat team ko de deti hoon. Team isi WhatsApp number pe aapse baat karke best option bataenge. Aap wait kijiye.`.replace(/\s+/g, ' ').trim();
  }
  const job = facts.employment === 'business' ? 'business' : 'salaried';
  return `Thank you, ${ji} 🙏 Aapki saari detail mil gayi: personal loan ₹${inr(facts.loanAmount)}, ${facts.tenureMonths} months, ${place}, ${job}, income ₹${inr(facts.income)}. Main yeh Apni Zaroorat team ko de deti hoon. Team isi WhatsApp number pe aapse baat karke best option bataenge. Aap wait kijiye.`;
}

export function factsInstruction(facts: ChatFacts, nextField: string): string {
  const lines = [
    facts.product === 'personal_loan' ? 'Chosen product: personal loan.' : '',
    facts.product === 'insurance' ? `Chosen product: insurance${facts.insType ? ` (${facts.insType})` : ''}.` : '',
    facts.name ? `Name already given: ${facts.name}. Do not ask the name again.` : '',
    facts.pincode ? `Pincode already given: ${facts.pincode}. Do not ask pincode again.` : '',
    facts.city ? `City already given: ${facts.city}.` : '',
    facts.employment ? `Employment already given: ${facts.employment}. Do not ask again.` : '',
    facts.income ? `Income already given: ${facts.income}. Do not invent a different income.` : '',
    facts.loanAmount ? `Loan amount already given: ${facts.loanAmount}.` : '',
    facts.tenureMonths ? `Tenure already given: ${facts.tenureMonths} months.` : '',
    facts.pan ? `PAN already given. Do not ask PAN again.` : '',
    facts.insDetail ? `Insurance detail already given: ${facts.insDetail}.` : '',
  ].filter(Boolean);
  const ask =
    nextField === 'done'
      ? 'All details are complete. Thank them, recap once, say the team will contact on this WhatsApp, and end. Do not ask another question. Do not say Navya. Do not mention PAN digits.'
      : `Ask exactly one next question, and nothing else. Next field only: ${nextField}. Do not mention later fields. Do not invent numbers the customer did not type.`;
  return [`Saved details for this WhatsApp number (never re-ask these):`, ...lines, ask].join('\n');
}

export function isSideQuestion(text: string): boolean {
  const t = text.trim();
  if (/^[1-9]\d{5}$/.test(t.replace(/\s/g, ''))) return false;
  if (/^\d{4,7}$/.test(t.replace(/\D/g, '')) && t.replace(/\D/g, '').length >= 4) return false;
  return isOffTopicText(t) || isAbuse(t);
}
