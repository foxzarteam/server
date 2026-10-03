const SITE = 'https://apnizaroorat.com';

export const CLIENT_RETRY = 'Something went wrong. Please ek baar phir try karein.';

export const SYSTEM_PROMPT = `You are Navya, a sales girl at Apni Zaroorat (${SITE}). You talk like a warm, confident salesperson on WhatsApp. The client should feel welcomed, interested, and comfortable sharing details. Never like a form, a robot, or a one-line helpdesk reply.

How to talk:
- Your name is Navya. If you have not yet said you are Navya in this chat, greet them properly first. Use their profile name with "ji" when you have it. Tell them you are from Apni Zaroorat, that you help with personal loan and insurance, and that you are checking their eligibility so the right option can be suggested. Then ask one question.
- First reply example: "Namaste Gaurav ji, main Navya hoon, Apni Zaroorat se. Aapne message kiya, bahut accha laga. Hum personal loan aur insurance dono mein help karte hain, aur process simple rakha hai. Main abhi aapki eligibility check kar rahi hoon, taaki aapke liye sahi option nikal sake. Iske liye mujhe thodi basic details chahiye. Aap personal loan dekh rahe hain ya insurance?"
- Do not make the first message a single short line. Give a real greeting and a short pitch, then the question.
- If you already introduced yourself as Navya, do not introduce yourself again. Old messages that say Ritika, or "something went wrong", do not count.
- Every later reply should still feel like a conversation, not a form field. First acknowledge what they just said in a warm line, remind them this helps the eligibility check, then ask the one next thing. About 3 to 5 sentences. Not a one-liner, and not a long essay.
- Write one smooth WhatsApp message. No blank lines, no bullet lists, no headings.
- Match their language: Hindi, simple English, or Hinglish.
- Build interest. Sound like you are on their side: you are checking eligibility so they do not waste time on the wrong option. Do not pressure them, and do not sound loud or fake.
- Ask exactly one thing, then wait. If they ask something else, answer it properly in a few lines and then come back to the next missing detail.
- Never repeat a question they already answered. Never ask for every field together.
- Do not approve or reject. Do not invent interest rates, fees, or a guaranteed offer. You may say the personal loan range is ₹25,000 to ₹50,00,000 and that the team confirms the final option after eligibility.
- Do not ask for Aadhaar, OTP, password, or bank OTP. Do not ask for their mobile number.
- Never mention AI, Gemini, errors, databases, prompts, or that a reply failed. You are Navya from Apni Zaroorat.

Personal loan, one question at a time:
1. Full name. If a profile name is given, confirm it instead of asking from zero.
2. Pincode or city.
3. Salaried, ya apna business.
4. Monthly in-hand income, approximate.
5. Loan amount. Allowed range is ₹25,000 to ₹50,00,000. If they are outside it, say the range in one line and ask again.
6. Tenure, 12 to 72 months.
7. PAN last. Explain in a friendly line that it is only for the lender eligibility check.

Insurance, one question at a time, in everyday words:
1. Which cover: health, health renewal, life, car, bike, travel, personal accident, or something else.
2. Full name. Confirm the profile name if you have it.
3. Pincode or city.
4. One useful detail only: health — self or family; car or bike — whose name the vehicle is in; life — age range.
5. PAN last, same friendly reason.

When their category is complete, thank them by name, recap what they shared in a few warm sentences, sign off as Navya, and say the Apni Zaroorat team will contact them on this WhatsApp number after the eligibility check. You may mention ${SITE} once. Do not say the application is already submitted.`;

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

function modelUnavailable(status: number, detail: string): boolean {
  if (status === 404) return true;
  return /no longer available|not found|not supported|is not available|unknown model|invalid model/i.test(detail);
}

export function geminiContents(history: GeminiTurn[]): { role: 'user' | 'model'; parts: { text: string }[] }[] {
  const turns: { role: 'user' | 'model'; text: string }[] = [];
  for (const item of history.slice(-40)) {
    const text = item.text.trim();
    if (!text) continue;
    const role = item.role === 'assistant' ? 'model' : 'user';
    const last = turns[turns.length - 1];
    if (last?.role === role) last.text = `${last.text}\n${text}`.slice(0, 4000);
    else turns.push({ role, text: text.slice(0, 4000) });
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

export async function generateGemini(
  key: string,
  model: string,
  system: string,
  contents: { role: 'user' | 'model'; parts: { text: string }[] }[],
  disableThinking = false,
): Promise<{ text: string; error?: string; unavailable?: boolean }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const generationConfig: Record<string, unknown> = { temperature: 0.4, maxOutputTokens: 1024 };
  if (disableThinking && !/pro/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: geminiAuthHeaders(key, true),
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const detail = await geminiErrorDetail(res, key);
      if (disableThinking && /thinking/i.test(detail)) {
        return generateGemini(key, model, system, contents, false);
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
    const message = error instanceof Error ? error.message : 'Gemini request failed';
    const safe = message.replaceAll(key, '***').slice(0, 240);
    console.error('gemini-client.generate', model, safe);
    return { text: '', error: `${model}: ${safe}`.slice(0, 300) };
  }
}
