import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_WP_ENQUIRIES } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import { allowRateLimitedAction } from '../security/rate-limit';
import { canonicalWhatsappPhone, extractInboundMessages, InboundWhatsappMessage } from './whatsapp-inbound';
import { WhatsappSettings, WhatsappSettingsService } from './whatsapp-settings.service';
import { whatsappSignatureOk } from './whatsapp-verify';

const GRAPH_VERSION = 'v21.0';
const MAX_MESSAGES = 1000;
const SITE = 'https://apnizaroorat.com';

async function metaErrorText(res: Response): Promise<string> {
  let detail = '';
  let code: number | undefined;
  try {
    const data = (await res.json()) as { error?: { message?: string; code?: number } };
    const message = String(data.error?.message ?? '').trim();
    code = data.error?.code;
    if (message) detail = code ? `${code}: ${message}` : message;
  } catch {
    detail = '';
  }
  let text = detail || `WhatsApp send failed (${res.status})`;
  if (code === 100 || /authorization error/i.test(text)) {
    text = `${text}. Access token is invalid, expired, or not allowed to send from this phone number ID.`;
  }
  return text.slice(0, 500);
}

type GeminiPart = { text?: string; thought?: boolean };
type GeminiReply = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

function geminiContents(history: ChatMessage[]): { role: 'user' | 'model'; parts: { text: string }[] }[] {
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

type ListedGeminiModel = { name?: string; supportedGenerationMethods?: string[] };

function geminiModelScore(id: string): number {
  let score = 0;
  if (/flash/i.test(id)) score += 100;
  if (/lite/i.test(id)) score += 10;
  if (/pro/i.test(id)) score -= 30;
  if (/preview|exp|experimental/i.test(id)) score -= 40;
  return score;
}

function chatModelId(model: ListedGeminiModel): string {
  const id = String(model.name ?? '').replace(/^models\//, '').trim();
  const methods = model.supportedGenerationMethods ?? [];
  if (!id || !methods.includes('generateContent')) return '';
  if (!/^gemini-/i.test(id)) return '';
  if (/embed|imagen|veo|tts|image|audio|live|robot|computer|nano|gemma|aqa/i.test(id)) return '';
  return id;
}

function modelUnavailable(status: number, detail: string): boolean {
  if (status === 404) return true;
  return /no longer available|not found|not supported|is not available|unknown model|invalid model/i.test(detail);
}

export function defaultGeminiModel(available: string[]): string {
  return available[0] || '';
}

async function listGeminiChatModels(key: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';
  for (let page = 0; page < 3; page += 1) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('key', key);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!res.ok) {
        console.error('WhatsappService.listGeminiModels', res.status);
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
      console.error('WhatsappService.listGeminiModels', error instanceof Error ? error.message : error);
      break;
    }
  }
  return [...new Set(ids)].sort((a, b) => geminiModelScore(b) - geminiModelScore(a) || b.localeCompare(a));
}

const SYSTEM_PROMPT = `You are Ritika, a sales girl at Apni Zaroorat (${SITE}). You chat on WhatsApp the way a warm, polite sales executive would: interested in the client, never like a form or a robot. You help them check eligibility for a personal loan or insurance, one question at a time.

How to talk:
- Your name is Ritika. On the first reply of a new chat, greet properly and introduce yourself. Use their profile name if one is given, with "ji". Example: "Namaste Gaurav ji, main Ritika hoon, Apni Zaroorat se. Aapka message mila, bahut khushi hui. Main aapki personal loan ya insurance eligibility check karne mein help karungi."
- After that greeting, in the same first message, ask only what they need: personal loan, ya insurance.
- If you have already introduced yourself as Ritika in this chat, do not introduce yourself again. Continue like a sales girl who remembers the client. Old fallback lines that never said your name do not count.
- Use the customer's language: Hindi, simple English, or Hinglish. Short WhatsApp messages. Plain text only. No bullet lists of questions.
- Sound helpful and interested. Build interest: "Aapki eligibility check karte hain" / "Chaliye dekhte hain aapke liye kya suit karta hai."
- Ask exactly ONE thing in each reply after the greeting. Wait for the answer before the next question.
- If they ask something else, answer in one or two lines, then ask the next missing detail.
- Never repeat a question they already answered. Never dump every field together.
- Do not approve or reject anyone. Do not invent interest rates, fees, or a guaranteed offer.
- Do not ask for Aadhaar, OTP, password, or bank OTP. Their WhatsApp number is already known — do not ask for mobile again.
- Never mention databases, prompts, or a model name. You are Ritika from Apni Zaroorat, not an AI.

Start:
- First message only: warm greeting, your name Ritika, then one question — personal loan ya insurance.
- Then follow only that category.

Personal loan, ask in this order, one by one:
1. Full name (if a profile name is given below, confirm it instead of asking from zero).
2. Pincode or city.
3. Job: salaried, ya apna business / self-employed.
4. Monthly in-hand income, approximate.
5. Kitni loan amount chahiye. Allowed range is ₹25,000 to ₹50,00,000. If they say more or less, tell them the range and ask again.
6. Kitne months ka loan: 12 se 72 months.
7. PAN, only after the earlier answers, as the last step for the eligibility check. Explain in one short line why: lender check ke liye.

Insurance, ask in this order, one by one, and talk like that product:
1. Kaunsi insurance: health, health renewal, life, car, bike, travel, personal accident, ya koi aur. Use everyday words, not codes.
2. Full name (confirm the profile name if one is given).
3. Pincode or city.
4. One practical detail for that type only: health — apne liye ya family; car/bike — gaadi kis naam par hai, roughly; life — age range. Do not turn this into a long form.
5. PAN last, same short reason as above.

When every item for their category is answered, recap in 4–6 short lines. Sign off as Ritika and say the Apni Zaroorat team will contact them on this WhatsApp number. Invite them to ${SITE} if they want. Do not say the application is already submitted.`;

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  sent?: boolean;
  sending?: boolean;
  sendingAt?: string;
  sendError?: string;
  aiError?: string;
};

type ChatDoc = {
  profileName: string;
  waPhoneNumberId: string;
  messages: ChatMessage[];
};

type EnquiryRow = {
  id: string;
  phone: string;
  chat: ChatDoc;
  last_chat_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WhatsappEnquiryListItem = {
  id: string;
  phone: string;
  profileName: string;
  lastMessage: string;
  lastChatAt: string | null;
  createdAt: string;
};

export type WhatsappEnquiryDetail = {
  id: string;
  phone: string;
  profileName: string;
  lastChatAt: string | null;
  createdAt: string;
  messages: { id: string; role: 'user' | 'assistant'; text: string; at: string; sendError?: string; aiError?: string }[];
};

function asChat(raw: unknown): ChatDoc {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const obj = value && typeof value === 'object'
    ? (value as { profileName?: unknown; messages?: unknown; waPhoneNumberId?: unknown })
    : {};
  const messages = Array.isArray(obj.messages) ? obj.messages : [];
  const clean: ChatMessage[] = [];
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Partial<ChatMessage>;
    const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : null;
    const id = String(row.id ?? '').trim();
    if (!role || !id) continue;
    clean.push({
      id: id.slice(0, 200),
      role,
      text: String(row.text ?? '').slice(0, 4000),
      at: String(row.at ?? ''),
      ...(row.sent ? { sent: true } : {}),
      ...(row.sending ? { sending: true } : {}),
      ...(row.sendingAt ? { sendingAt: String(row.sendingAt) } : {}),
      ...(row.sendError ? { sendError: String(row.sendError).slice(0, 500) } : {}),
      ...(row.aiError ? { aiError: String(row.aiError).slice(0, 500) } : {}),
    });
  }
  return {
    profileName: String(obj.profileName ?? '').slice(0, 120),
    waPhoneNumberId: String(obj.waPhoneNumberId ?? '').replace(/\D/g, '').slice(0, 30),
    messages: clean.slice(-MAX_MESSAGES),
  };
}

@Injectable()
export class WhatsappService {
  private linkCache: { until: number; url: string | null } | null = null;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly settings: WhatsappSettingsService,
  ) {}

  private get table() {
    return this.supabase.from(TABLE_WP_ENQUIRIES);
  }

  async listChatModels(apiKey: string): Promise<string[]> {
    const key = apiKey.trim().replace(/\s+/g, '');
    if (!key) return [];
    return listGeminiChatModels(key);
  }

  /** Confirms the admin model with a real generate call. Picks a listed free-tier model only when that call says the model is unavailable. */
  async resolveGeminiModel(
    apiKey: string,
    requested: string,
  ): Promise<{ model: string; error?: string }> {
    const key = apiKey.trim().replace(/\s+/g, '');
    const wanted = requested.trim();
    if (!key) return { model: wanted, error: 'Gemini API key is not saved.' };
    const models = await listGeminiChatModels(key);
    if (wanted) {
      const test = await this.geminiGenerate(
        key,
        wanted,
        'Reply with the single word OK.',
        [{ role: 'user', parts: [{ text: 'Hi' }] }],
        true,
      );
      if (test.text) return { model: wanted };
      if (!test.unavailable) {
        return { model: wanted, error: test.error || `${wanted} did not return a reply.` };
      }
      const replacement = await this.firstWorkingGeminiModel(key, models.filter((model) => model !== wanted));
      if (replacement) {
        return {
          model: replacement,
          error: `${wanted} is not available for this API key. ${test.error || ''} Using ${replacement} instead.`.replace(/\s+/g, ' ').trim(),
        };
      }
      return { model: wanted, error: test.error || `${wanted} is not available for this API key.` };
    }
    const replacement = await this.firstWorkingGeminiModel(key, models);
    if (replacement) return { model: replacement };
    return { model: '', error: 'No Gemini model on this API key returned a reply. Check the key and Free Tier access.' };
  }

  private async firstWorkingGeminiModel(key: string, models: string[]): Promise<string> {
    for (const model of models.slice(0, 3)) {
      const test = await this.geminiGenerate(
        key,
        model,
        'Reply with the single word OK.',
        [{ role: 'user', parts: [{ text: 'Hi' }] }],
        true,
      );
      if (test.text) return model;
    }
    return '';
  }

  async handleWebhook(rawBody: Buffer, signatureHeader?: string): Promise<'ok' | 'forbidden'> {
    const settings = await this.settings.getEffective();
    if (!whatsappSignatureOk(rawBody, signatureHeader, settings.appSecret)) {
      return 'forbidden';
    }

    let payload: unknown = {};
    if (rawBody.length) {
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return 'ok';
      }
    }

    for (const message of extractInboundMessages(payload)) {
      try {
        await this.handleInbound(settings, message);
      } catch (error) {
        console.error('WhatsappService.handleInbound', message.messageId, error);
      }
    }
    return 'ok';
  }

  async publicLink(): Promise<string | null> {
    const now = Date.now();
    if (this.linkCache && this.linkCache.until > now) return this.linkCache.url;

    const settings = await this.settings.getEffective();
    let phone = settings.displayPhone;
    if (!phone && settings.accessToken && settings.phoneNumberId) {
      phone = await this.settings.lookupDisplayPhone(settings.phoneNumberId, settings.accessToken);
      if (phone) await this.settings.rememberDisplayPhone(phone);
    }
    const url = /^[0-9]{8,15}$/.test(phone)
      ? `https://wa.me/${phone}?text=${encodeURIComponent('Hi')}`
      : null;
    this.linkCache = { until: now + 60_000, url };
    return url;
  }

  clearLinkCache() {
    this.linkCache = null;
  }

  async listForAdmin(): Promise<WhatsappEnquiryListItem[]> {
    const { data, error } = await this.table
      .select('id, phone, chat, last_chat_at, created_at')
      .order('last_chat_at', { ascending: false, nullsFirst: false });

    if (error) {
      console.error('WhatsappService.listForAdmin', error.message);
      return [];
    }

    return ((data as EnquiryRow[]) ?? []).map((row) => {
      const chat = asChat(row.chat);
      const last = chat.messages[chat.messages.length - 1];
      return {
        id: row.id,
        phone: row.phone,
        profileName: chat.profileName,
        lastMessage: last?.text ?? '',
        lastChatAt: row.last_chat_at,
        createdAt: row.created_at,
      };
    });
  }

  async getForAdmin(id: string): Promise<WhatsappEnquiryDetail | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data, error } = await this.table
      .select('id, phone, chat, last_chat_at, created_at')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) {
      if (error) console.error('WhatsappService.getForAdmin', error.message);
      return null;
    }

    const row = data as EnquiryRow;
    const chat = asChat(row.chat);
    return {
      id: row.id,
      phone: row.phone,
      profileName: chat.profileName,
      lastChatAt: row.last_chat_at,
      createdAt: row.created_at,
      messages: chat.messages.map(({ id: messageId, role, text, at, sendError, aiError }) => ({
        id: messageId,
        role,
        text,
        at,
        ...(sendError ? { sendError } : {}),
        ...(aiError ? { aiError } : {}),
      })),
    };
  }

  private userText(message: InboundWhatsappMessage): string {
    const textLike = message.type === 'text' || message.type === 'button' || message.type === 'interactive';
    if (textLike && message.text) return message.text;
    if (textLike) return '[empty message]';
    return `[${message.type} message]`;
  }

  private async handleInbound(settings: WhatsappSettings, message: InboundWhatsappMessage) {
    const assistantId = `ai:${message.messageId}`;
    const userMessage: ChatMessage = {
      id: message.messageId,
      role: 'user',
      text: this.userText(message),
      at: new Date().toISOString(),
    };

    const appended = await this.appendMessage(
      message.phone,
      message.profileName,
      userMessage,
      message.phoneNumberId,
    );
    if (!appended) return;
    await this.flushUnsent(settings, message.phone, message.phoneNumberId);
    if (!appended.added) {
      await this.ensureReply(settings, appended.row, message, assistantId);
      return;
    }

    const limited = !allowRateLimitedAction(`wa-in:${message.phone}`, 20, 10 * 60_000);
    const reply = limited
      ? { text: 'Please wait a few minutes before sending more messages.' }
      : await this.buildReply(settings, appended.row.chat.messages, message);
    await this.storeAndSend(
      settings,
      appended.row,
      message.profileName,
      assistantId,
      reply.text,
      message.phoneNumberId,
      reply.aiError,
    );
  }

  private async ensureReply(
    settings: WhatsappSettings,
    row: EnquiryRow,
    message: InboundWhatsappMessage,
    assistantId: string,
  ) {
    const assistant = row.chat.messages.find((item) => item.id === assistantId);
    if (assistant?.sent) return;
    if (assistant) {
      await this.deliver(settings, row.phone, assistantId, assistant.text, row.chat.waPhoneNumberId);
      return;
    }
    const reply = await this.buildReply(settings, row.chat.messages, message);
    await this.storeAndSend(settings, row, message.profileName, assistantId, reply.text, message.phoneNumberId, reply.aiError);
  }

  private async buildReply(
    settings: WhatsappSettings,
    history: ChatMessage[],
    message: InboundWhatsappMessage,
  ): Promise<{ text: string; aiError?: string }> {
    const textLike = message.type === 'text' || message.type === 'button' || message.type === 'interactive';
    if (!textLike || !message.text) {
      return { text: 'Please send your question as a text message.' };
    }
    if (!settings.geminiApiKey) {
      return {
        text: `Thanks for messaging Apni Zaroorat. Please visit ${SITE} and we will help you from there.`,
        aiError: 'Gemini API key is not saved in Settings.',
      };
    }
    const ai = await this.askGemini(settings, history, message);
    if (ai.text) return { text: ai.text };
    return {
      text: `Sorry, I could not reply just now. Please try again shortly, or visit ${SITE}.`,
      aiError: ai.error || 'Gemini returned an empty reply.',
    };
  }

  private async askGemini(
    settings: WhatsappSettings,
    history: ChatMessage[],
    message: InboundWhatsappMessage,
  ): Promise<{ text: string; error?: string }> {
    const key = settings.geminiApiKey.trim().replace(/\s+/g, '');
    const knownName = message.profileName.trim();
    const customerNote = knownName
      ? `Customer WhatsApp number: ${message.phone}. Profile name on WhatsApp: ${knownName}. Confirm this name; do not ask for the phone number.`
      : `Customer WhatsApp number: ${message.phone}. No profile name. Ask their name when that step comes. Do not ask for the phone number.`;
    const contents = geminiContents(history);
    if (!key) return { text: '', error: 'Gemini API key is not saved.' };
    if (contents.length === 0) return { text: '', error: 'No customer text to send to Gemini.' };

    const configured = settings.geminiModel.trim();
    const errors: string[] = [];
    if (configured) {
      const selected = await this.geminiGenerate(key, configured, `${SYSTEM_PROMPT}\n\n${customerNote}`, contents, true);
      if (selected.text) return { text: selected.text };
      if (!selected.unavailable) return { text: '', error: selected.error || 'Gemini returned an empty reply.' };
      if (selected.error) errors.push(selected.error);
    }

    const available = await listGeminiChatModels(key);
    const fallback = available.find((model) => model !== configured) || '';
    if (fallback) {
      const result = await this.geminiGenerate(key, fallback, `${SYSTEM_PROMPT}\n\n${customerNote}`, contents, true);
      if (result.text) return { text: result.text };
      if (result.error) errors.push(result.error);
    }
    return { text: '', error: errors.join(' | ').slice(0, 500) || 'Gemini returned an empty reply.' };
  }

  private async geminiGenerate(
    key: string,
    model: string,
    system: string,
    contents: { role: 'user' | 'model'; parts: { text: string }[] }[],
    disableThinking = false,
  ): Promise<{ text: string; error?: string; unavailable?: boolean }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const generationConfig: Record<string, unknown> = { temperature: 0.4, maxOutputTokens: 1024 };
    if (disableThinking && !/pro/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          return this.geminiGenerate(key, model, system, contents, false);
        }
        const error = `${model}: ${detail}`.slice(0, 500);
        console.error('WhatsappService.askGemini', error);
        return { text: '', error, unavailable: modelUnavailable(res.status, detail) };
      }
      const data = (await res.json()) as GeminiReply;
      const text = visibleGeminiText(data).slice(0, 4000);
      if (text) return { text };
      const reason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'empty';
      const error = `${model}: empty reply (${reason})`.slice(0, 300);
      console.error('WhatsappService.askGemini', error);
      return { text: '', error };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gemini request failed';
      const safe = message.replaceAll(key, '***').slice(0, 240);
      console.error('WhatsappService.askGemini', model, safe);
      return { text: '', error: `${model}: ${safe}`.slice(0, 300) };
    }
  }

  private async storeAndSend(
    settings: WhatsappSettings,
    row: EnquiryRow,
    profileName: string,
    assistantId: string,
    text: string,
    waPhoneNumberId = '',
    aiError = '',
  ) {
    const already = row.chat.messages.some((item) => item.id === assistantId);
    if (!already) {
      const appended = await this.appendMessage(
        row.phone,
        profileName,
        {
          id: assistantId,
          role: 'assistant',
          text,
          at: new Date().toISOString(),
          ...(aiError ? { aiError: aiError.slice(0, 500) } : {}),
        },
        waPhoneNumberId || row.chat.waPhoneNumberId,
      );
      if (!appended) return;
    }
    await this.deliver(settings, row.phone, assistantId, text, waPhoneNumberId || row.chat.waPhoneNumberId);
  }

  /** Resend replies that were saved but never delivered (Meta will not always retry). */
  private async flushUnsent(settings: WhatsappSettings, phone: string, waPhoneNumberId = '') {
    const row = await this.readByPhone(phone);
    if (!row) return;
    const fromId = waPhoneNumberId || row.chat.waPhoneNumberId;
    const pending = row.chat.messages.filter((item) => item.role === 'assistant' && !item.sent).slice(-5);
    for (const item of pending) {
      await this.deliver(settings, phone, item.id, item.text, fromId);
    }
  }

  /** Only one worker sends a given reply. A stale claim can be taken again after a crash. */
  private async deliver(
    settings: WhatsappSettings,
    phone: string,
    messageId: string,
    text: string,
    waPhoneNumberId = '',
  ) {
    const claimed = await this.claimSend(phone, messageId);
    if (!claimed) return;
    const result = await this.sendWhatsapp(settings, phone, text, waPhoneNumberId);
    if (result.ok) await this.markSent(phone, messageId);
    else {
      await this.releaseSend(phone, messageId);
      if (result.error) await this.noteSendError(phone, messageId, result.error);
    }
  }

  private async sendWhatsapp(
    settings: WhatsappSettings,
    phone: string,
    text: string,
    waPhoneNumberId = '',
  ): Promise<{ ok: boolean; error?: string }> {
    const token = settings.accessToken.trim().replace(/^bearer\s+/i, '').trim();
    const fromId = (waPhoneNumberId || settings.phoneNumberId).replace(/\D/g, '');
    if (!token || !fromId || !text.trim()) {
      const error = !token
        ? 'WhatsApp access token is missing in Settings.'
        : 'WhatsApp phone number ID is missing in Settings.';
      console.error('WhatsappService.sendWhatsapp', error);
      return { ok: false, error };
    }
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(fromId)}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: { preview_url: false, body: text.slice(0, 4000) },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const error = await metaErrorText(res);
        console.error('WhatsappService.sendWhatsapp', error);
        return { ok: false, error };
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'WhatsApp send failed';
      console.error('WhatsappService.sendWhatsapp', message);
      return { ok: false, error: message.slice(0, 300) };
    }
  }

  private async readByPhone(phone: string): Promise<EnquiryRow | null> {
    const { data, error } = await this.table
      .select('id, phone, chat, last_chat_at, created_at, updated_at')
      .eq('phone', phone)
      .maybeSingle();
    if (error) {
      console.error('WhatsappService.readByPhone', error.message);
      return null;
    }
    if (!data) return null;
    const row = data as EnquiryRow;
    return { ...row, chat: asChat(row.chat) };
  }

  private async appendMessage(
    phone: string,
    profileName: string,
    message: ChatMessage,
    waPhoneNumberId = '',
  ): Promise<{ row: EnquiryRow; added: boolean } | null> {
    const key = canonicalWhatsappPhone(phone);
    if (!/^[0-9]{8,15}$/.test(key)) return null;
    phone = key;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.readByPhone(phone);
      if (current?.chat.messages.some((item) => item.id === message.id)) {
        return { row: current, added: false };
      }

      const chat: ChatDoc = {
        profileName: profileName.trim() || current?.chat.profileName || '',
        waPhoneNumberId: (waPhoneNumberId || current?.chat.waPhoneNumberId || '').replace(/\D/g, '').slice(0, 30),
        messages: [...(current?.chat.messages ?? []), message].slice(-MAX_MESSAGES),
      };
      const now = new Date().toISOString();
      const lastChatAt = message.at || now;

      if (!current) {
        const { data, error } = await this.table
          .insert({
            phone,
            chat,
            last_chat_at: lastChatAt,
            updated_at: now,
          })
          .select('id, phone, chat, last_chat_at, created_at, updated_at')
          .maybeSingle();
        if (!error && data) {
          const row = data as EnquiryRow;
          return { row: { ...row, chat: asChat(row.chat) }, added: true };
        }
        if (error?.code === '23505') continue;
        console.error('WhatsappService.appendMessage.insert', error?.message);
        return null;
      }

      const { data, error } = await this.table
        .update({ chat, last_chat_at: lastChatAt, updated_at: now })
        .eq('id', current.id)
        .eq('updated_at', current.updated_at)
        .select('id, phone, chat, last_chat_at, created_at, updated_at')
        .maybeSingle();

      if (!error && data) {
        const row = data as EnquiryRow;
        return { row: { ...row, chat: asChat(row.chat) }, added: true };
      }
      if (error) console.error('WhatsappService.appendMessage.update', error.message);
    }

    const latest = await this.readByPhone(phone);
    if (!latest) return null;
    if (latest.chat.messages.some((item) => item.id === message.id)) {
      return { row: latest, added: false };
    }
    const chat: ChatDoc = {
      profileName: profileName.trim() || latest.chat.profileName || '',
      waPhoneNumberId: (waPhoneNumberId || latest.chat.waPhoneNumberId || '').replace(/\D/g, '').slice(0, 30),
      messages: [...latest.chat.messages, message].slice(-MAX_MESSAGES),
    };
    const now = new Date().toISOString();
    const { data, error } = await this.table
      .update({ chat, last_chat_at: message.at || now, updated_at: now })
      .eq('id', latest.id)
      .select('id, phone, chat, last_chat_at, created_at, updated_at')
      .maybeSingle();
    if (error || !data) {
      console.error('WhatsappService.appendMessage.fallback', error?.message);
      return null;
    }
    const row = data as EnquiryRow;
    return { row: { ...row, chat: asChat(row.chat) }, added: true };
  }

  private async patchMessage(
    phone: string,
    messageId: string,
    patch: (message: ChatMessage) => ChatMessage,
    when: (message: ChatMessage) => boolean,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.readByPhone(phone);
      if (!current) return false;
      const target = current.chat.messages.find((item) => item.id === messageId);
      if (!target || !when(target)) return false;
      const chat: ChatDoc = {
        ...current.chat,
        messages: current.chat.messages.map((item) => (item.id === messageId ? patch(item) : item)),
      };
      const { data, error } = await this.table
        .update({ chat, updated_at: new Date().toISOString() })
        .eq('id', current.id)
        .eq('updated_at', current.updated_at)
        .select('id')
        .maybeSingle();
      if (!error && data) return true;
      if (error) console.error('WhatsappService.patchMessage', error.message);
    }
    return false;
  }

  private claimSend(phone: string, messageId: string) {
    return this.patchMessage(
      phone,
      messageId,
      (message) => ({ ...message, sending: true, sendingAt: new Date().toISOString() }),
      (message) => !message.sent && (!message.sending || this.claimIsStale(message)),
    );
  }

  private claimIsStale(message: ChatMessage): boolean {
    const at = Date.parse(message.sendingAt ?? '');
    return !Number.isFinite(at) || Date.now() - at > 45_000;
  }

  private markSent(phone: string, messageId: string) {
    return this.patchMessage(
      phone,
      messageId,
      (message) => {
        const next = { ...message, sent: true };
        delete next.sending;
        delete next.sendingAt;
        delete next.sendError;
        return next;
      },
      (message) => !message.sent,
    );
  }

  private noteSendError(phone: string, messageId: string, error: string) {
    const sendError = error.slice(0, 500);
    return this.patchMessage(
      phone,
      messageId,
      (message) => ({ ...message, sendError }),
      (message) => !message.sent,
    );
  }

  private releaseSend(phone: string, messageId: string) {
    return this.patchMessage(
      phone,
      messageId,
      (message) => {
        const next = { ...message };
        delete next.sending;
        delete next.sendingAt;
        return next;
      },
      (message) => !message.sent && Boolean(message.sending),
    );
  }
}
