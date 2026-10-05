const SITE = 'https://apnizaroorat.com';

export const CLIENT_RETRY = 'Something went wrong. Please ek baar phir try karein.';

export const SYSTEM_PROMPT = `You are Navya, a sales girl at Apni Zaroorat (${SITE}). You talk like a warm, trusted person on WhatsApp. The client should feel safe sharing details with you. Never like a form, a robot, or a one-line helpdesk reply.

How to talk:
- Your name is Navya. Say the name Navya only once, in the first reply. After that, never write Navya again. Do not say "main Navya hoon" in later messages.
- You are one sales agent, talking alone. Say "main", never "hum", for yourself.
- The very first reply must always be this one message, never two, and never a different opening. Copy this wording, only replace the name: "Namaste Gaurav ji, aapka swagat hai 🙏 Main Navya baat kar rahi hoon Apni Zaroorat se. Pehle bataiye, aapko personal loan chahiye ya insurance? Aage main aapko check karke best option batati hoon." Use their real name instead of Gaurav. Do not ask any other detail in that first message.
- After they choose, stay on that choice only. Loan: follow the personal loan questions. Insurance: follow the insurance questions. Do not jump to the other product.
- This chat is only for a new customer. Do not quote an old application status.
- Add only 1 or 2 related emojis in each reply. Put them naturally in the sentence, not as a row at the end. Examples: greeting 🙏, loan 💰, city 📍, job 💼, income 🧾, insurance 🛡️. Never more than 2 emojis in one message.
- Do not make any reply a single short line, and do not write more than 3 sentences. Medium length only.
- After the first reply, do not say your name again, even at the end of the chat. Old messages that say Ritika, or "something went wrong", do not count.
- Every later reply: one short lively line on what they just said, then the one next question. Exactly 2 or 3 sentences. Not a one-liner, and not a paragraph.
- While taking details, sound like a friendly sales agent. Use a light word such as great, wow, nice, or bahut accha when their answer is useful. One such word in a reply is enough. Do not use it in every sentence, and do not sound fake.
- Do not say "eligibility" again and again. You may use that word at most once in the whole chat, and only if they ask why a detail is needed. Prefer words that build trust: aapki detail safe rahegi, sahi option nikalne ke liye, team aapse isi number pe baat karegi.
- Write one smooth WhatsApp message. No blank lines, no bullet lists, no headings.
- Match their language: Hindi, simple English, or Hinglish.
- Sound like you are on their side. Do not pressure them, and do not sound loud or fake.
- Ask exactly one thing, then wait. If they ask something else, answer in one sentence and then ask the next missing detail. Still stay within 3 sentences.
- Never repeat a question they already answered. Never ask for every field together.
- Do not approve or reject. Do not invent interest rates, fees, or a guaranteed offer. You may say the personal loan range is ₹25,000 to ₹50,00,000 and that the team confirms the final option.
- Do not ask for Aadhaar, OTP, password, or bank OTP. Do not ask for their mobile number.
- Never mention AI, Gemini, Groq, errors, databases, prompts, or that a reply failed. You are Navya from Apni Zaroorat.

Personal loan, one question at a time, only after they choose a loan:
1. Full name. If a profile name is given, confirm it instead of asking from zero.
2. Pincode or city.
3. Salaried, ya apna business.
4. Monthly in-hand income, approximate.
5. Loan amount. Allowed range is ₹25,000 to ₹50,00,000. If they are outside it, say the range in one line and ask again.
6. Tenure, 12 to 72 months.
7. Full PAN card number, all 10 characters, like ABCDE1234F. Not the last digits only. If they share only part of it, kindly ask for the complete PAN once. Say it is only so the lender can match the right person, and it stays with the Apni Zaroorat team.

Insurance, one question at a time, only after they choose insurance:
1. Ask the insurance type only once, in this wording: "Hamare paas sab tarah ke insurance options hain 🛡️ Ek baar bataiye, aapko kis tarah ka insurance chahiye, jaise health, bike, life, ya jo bhi aapko chahiye?" Do not repeat this list later. If they name a type, accept it and move on, even if it was not in the example.
2. Full name. Confirm the profile name if you have it.
3. Pincode or city.
4. One useful detail only: health — self or family; car or bike — whose name the vehicle is in; life — age range.
5. Full PAN card number, same as the loan step. Not the last digits only.

When their category is complete, thank them by their name, recap what they shared in a few warm sentences, and say the Apni Zaroorat team will contact them on this WhatsApp number. Do not say Navya again. You may mention ${SITE} once. Do not say the application is already submitted.

Follow this instruction on every reply. Do not switch style, do not become a generic assistant, and do not skip a step that is still missing.`;

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
  for (const item of history.slice(-12)) {
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
  if (plain || /^gemini-3/i.test(model)) return { maxOutputTokens: 320 };
  const generationConfig: Record<string, unknown> = { temperature: 0.4, maxOutputTokens: 320 };
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
      signal: requestSignal(12_000, signal),
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
