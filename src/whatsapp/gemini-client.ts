const SITE = 'https://apnizaroorat.com';

export const CLIENT_RETRY = 'Something went wrong. Please ek baar phir try karein.';

export const SYSTEM_PROMPT = `You are Navya, a sales girl at Apni Zaroorat (${SITE}). Warm WhatsApp Hinglish. Say "main", never "hum". Say the name Navya only if this is the first reply.

Rules:
- Read the last customer message and understand it. Do not treat a question, joke, or abuse as a pincode, city, income, amount, or PAN.
- One WhatsApp message. Two short sentences. Exactly one question — the pending field in the note.
- Never invent income, amount, city, EMI, interest rate, or PAN.
- Never re-ask a detail that is already in the customer note.
- Never pack job, income, and loan amount in one reply.
- Do not approve or reject. Personal loan range is ₹25,000 to ₹50,00,000.
- No Aadhaar, OTP, password, or mobile number. Never mention AI, Gemini, or Groq.
- 1 emoji max. Match their language.

If they already chose a product, stay on it. Loan order: name, pincode, salaried/business, income, amount, tenure 12-72, full PAN. Insurance order: type, name, pincode, one extra detail, full PAN.

If they ask EMI, rate, or something off-topic: one line — pehle details share karein, team verify karke eligibility ke hisaab se best option batayegi. Then ask only the pending field. Do not quote their off-topic text as a saved detail.

If they insult or say nonsense: stay calm. You are here to check details and give the best solution after eligibility. Then ask only the pending field.`;

/** One instruction for Groq and Gemini. Customer note is only the name and phone for this chat. */
export function navyaInstruction(customerNote: string): string {
  const note = customerNote.trim();
  return note ? `${SYSTEM_PROMPT}\n\n${note}` : SYSTEM_PROMPT;
}

type ListedGeminiModel = { name?: string; supportedGenerationMethods?: string[] };
type GeminiPart = { text?: string; thought?: boolean };
type GeminiReply = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

export type GeminiTurn = { role: 'user' | 'assistant'; text: string };

export function geminiModelScore(id: string): number {
  let score = 0;
  if (/flash/i.test(id)) score += 100;
  if (/lite/i.test(id)) score += 10;
  if (/pro/i.test(id)) score -= 30;
  if (/preview|exp|experimental/i.test(id)) score -= 40;
  return score;
}

export function chatModelId(model: ListedGeminiModel): string {
  const id = String(model.name ?? '').replace(/^models\//, '').trim();
  const methods = model.supportedGenerationMethods ?? [];
  if (!id || !methods.includes('generateContent')) return '';
  if (!/^gemini-/i.test(id)) return '';
  if (/embed|imagen|veo|tts|image|audio|live|robot|computer|nano|gemma|aqa/i.test(id)) return '';
  return id;
}

export function defaultGeminiModel(available: string[]): string {
  return available[0] || '';
}

export function smoothReply(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

function geminiAuthHeaders(key: string, json = false): Record<string, string> {
  return {
    'x-goog-api-key': key,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function requestSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!parent) return timeout;
  return AbortSignal.any([timeout, parent]);
}

function modelUnavailable(status: number, detail: string): boolean {
  if (status === 404) return true;
  return /no longer available|not found|not supported|is not available|unknown model|invalid model/i.test(detail);
}

export function geminiContents(history: GeminiTurn[]): { role: 'user' | 'model'; parts: { text: string }[] }[] {
  const turns: { role: 'user' | 'model'; text: string }[] = [];
  for (const item of history.slice(-8)) {
    const text = item.text.trim();
    if (!text) continue;
    const role = item.role === 'assistant' ? 'model' : 'user';
    const last = turns[turns.length - 1];
    if (last?.role === role) last.text = `${last.text}\n${text}`.slice(0, 1200);
    else turns.push({ role, text: text.slice(0, 1200) });
  }
  while (turns[0]?.role === 'model') turns.shift();
  return turns.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] }));
}

function visibleGeminiText(data: GeminiReply): string {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => part && part.thought !== true && part.text)
    .map((part) => String(part.text))
    .join('')
    .trim();
}

async function geminiErrorDetail(res: Response, key: string): Promise<string> {
  let detail = '';
  try {
    const data = (await res.json()) as { error?: { message?: string; status?: string } };
    detail = String(data.error?.message || data.error?.status || '');
  } catch {
    detail = '';
  }
  return (detail || `HTTP ${res.status}`).replaceAll(key, '***').slice(0, 240);
}

export async function listGeminiChatModels(key: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';
  for (let page = 0; page < 3; page += 1) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    try {
      const res = await fetch(url, {
        headers: geminiAuthHeaders(key),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        console.error('gemini-client.listModels', res.status);
        break;
      }
      const data = (await res.json()) as { models?: ListedGeminiModel[]; nextPageToken?: string };
      for (const model of data.models ?? []) {
        const id = chatModelId(model);
        if (id) ids.push(id);
      }
      pageToken = String(data.nextPageToken ?? '');
      if (!pageToken) break;
    } catch (error) {
      console.error('gemini-client.listModels', error instanceof Error ? error.message : error);
      break;
    }
  }
  return [...new Set(ids)].sort((a, b) => geminiModelScore(b) - geminiModelScore(a) || b.localeCompare(a));
}

/** Gemini 3 rejects the old thinkingBudget field with a bare "invalid argument" error. */
function generationConfigFor(model: string, plain: boolean): Record<string, unknown> {
  if (plain || /^gemini-3/i.test(model)) return { maxOutputTokens: 180 };
  const generationConfig: Record<string, unknown> = { temperature: 0.3, maxOutputTokens: 180 };
  if (!/pro/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return generationConfig;
}

export async function generateGemini(
  key: string,
  model: string,
  system: string,
  contents: { role: 'user' | 'model'; parts: { text: string }[] }[],
  disableThinking = false,
  plain = false,
  signal?: AbortSignal,
): Promise<{ text: string; error?: string; unavailable?: boolean }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const alreadyPlain = plain || !disableThinking || /^gemini-3/i.test(model);
  const generationConfig = generationConfigFor(model, alreadyPlain);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: geminiAuthHeaders(key, true),
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig,
      }),
      signal: requestSignal(8_000, signal),
    });
    if (!res.ok) {
      const detail = await geminiErrorDetail(res, key);
      if (!alreadyPlain && /thinking|invalid argument/i.test(detail)) {
        return generateGemini(key, model, system, contents, false, true, signal);
      }
      const error = `${model}: ${detail}`.slice(0, 500);
      console.error('gemini-client.generate', error);
      return { text: '', error, unavailable: modelUnavailable(res.status, detail) };
    }
    const data = (await res.json()) as GeminiReply;
    const text = visibleGeminiText(data).slice(0, 4000);
    if (text) return { text };
    const reason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'empty';
    const error = `${model}: empty reply (${reason})`.slice(0, 300);
    console.error('gemini-client.generate', error);
    return { text: '', error };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return { text: '' };
    }
    const message = error instanceof Error ? error.message : 'Gemini request failed';
    const safe = message.replaceAll(key, '***').slice(0, 240);
    console.error('gemini-client.generate', model, safe);
    return { text: '', error: `${model}: ${safe}`.slice(0, 300) };
  }
}
