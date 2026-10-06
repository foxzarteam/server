import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_LEADS, TABLE_WP_ENQUIRIES } from '../common/constants';
import { isDraftLead, normalizeStoredCategory, productLabel, statusLabel } from '../leads/lead-present';
import { SUPABASE_CLIENT } from '../config/supabase';
import { allowRateLimitedAction } from '../security/rate-limit';
import {
  closingReply,
  collectChatFacts,
  conversationClosed,
  factsInstruction,
  isSideQuestion,
  nextMissingField,
  parseChatFacts,
  scriptedNavyaReply,
  type ChatFacts,
} from './whatsapp-facts';
import { canonicalWhatsappPhone, extractInboundMessages, InboundWhatsappMessage } from './whatsapp-inbound';
import { WhatsappSettings, WhatsappSettingsService } from './whatsapp-settings.service';
import { whatsappSignatureOk } from './whatsapp-verify';
import {
  defaultGeminiModel,
  geminiContents,
  generateGemini,
  listGeminiChatModels,
  navyaInstruction,
  smoothReply,
} from './gemini-client';
import { defaultGroqModel, generateGroq, listGroqChatModels } from './groq-client';

export { defaultGeminiModel };

const GRAPH_VERSION = 'v21.0';
const MAX_MESSAGES = 1000;
const EXISTING_MARK = 'EXISTING\n';
const STATUS_LOOKUP_RETRY =
  'Namaste ji 🙏 Aapki application ka status abhi nahi nikal paaya. Kripya thodi der baad ek baar message karein.';

function existingStatusText(name: string, lines: { product: string; status: string }[]): string {
  const who = name ? `${name} ji` : 'ji';
  const body =
    lines.length === 1
      ? `Aapki ${lines[0].product} application ka status: ${lines[0].status}.`
      : `Aapki applications ka status:\n${lines.map((line) => `${line.product}: ${line.status}`).join('\n')}`;
  return `Namaste ${who} 🙏\n\n${body}\n\nApni Zaroorat team isi WhatsApp number pe aapko update degi.`;
}

function firstAiReply(
  tasks: { task: Promise<{ text: string; error?: string }>; stop: () => void; replyBy: 'groq' | 'gemini' }[],
): Promise<{ text: string; error?: string; replyBy?: 'groq' | 'gemini' }> {
  return new Promise((resolve) => {
    let left = tasks.length;
    let done = false;
    const errors: string[] = [];
    if (!left) {
      resolve({ text: '', error: 'AI returned an empty reply.' });
      return;
    }
    const finish = (result: { text: string; error?: string; replyBy?: 'groq' | 'gemini' }) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    tasks.forEach((item, index) => {
      item.task
        .then((result) => {
          if (done) return;
          if (result.text) {
            tasks.forEach((other, otherIndex) => {
              if (otherIndex !== index) other.stop();
            });
            finish({ ...result, replyBy: item.replyBy });
            return;
          }
          if (result.error) errors.push(result.error);
          left -= 1;
          if (left === 0) finish({ text: '', error: errors.join(' | ').slice(0, 500) });
        })
        .catch((error: unknown) => {
          if (done) return;
          errors.push(error instanceof Error ? error.message : 'AI request failed');
          left -= 1;
          if (left === 0) finish({ text: '', error: errors.join(' | ').slice(0, 500) });
        });
    });
  });
}

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
  /** Which model wrote this reply. Only set on AI replies. */
  replyBy?: 'groq' | 'gemini';
};

type ChatDoc = {
  profileName: string;
  waPhoneNumberId: string;
  messages: ChatMessage[];
  /** Empty means a new customer. A saved status means that message was already sent. */
  leadNote?: string;
  facts?: ChatFacts;
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
  messages: { id: string; role: 'user' | 'assistant'; text: string; at: string; sendError?: string; aiError?: string; replyBy?: 'groq' | 'gemini' }[];
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
    ? (value as { profileName?: unknown; messages?: unknown; waPhoneNumberId?: unknown; leadNote?: unknown; facts?: unknown })
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
      ...(row.replyBy === 'groq' || row.replyBy === 'gemini' ? { replyBy: row.replyBy } : {}),
    });
  }
  return {
    profileName: String(obj.profileName ?? '').slice(0, 120),
    waPhoneNumberId: String(obj.waPhoneNumberId ?? '').replace(/\D/g, '').slice(0, 30),
    messages: clean.slice(-MAX_MESSAGES),
    ...(typeof obj.leadNote === 'string' ? { leadNote: obj.leadNote.slice(0, 1500) } : {}),
    facts: parseChatFacts(obj.facts),
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

  async listGroqModels(apiKey: string): Promise<string[]> {
    const key = apiKey.trim().replace(/\s+/g, '');
    if (!key) return [];
    return listGroqChatModels(key);
  }

  /** Keeps the saved Groq model when Groq still lists it. Otherwise picks the fastest listed chat model. */
  async resolveGroqModel(apiKey: string, requested: string): Promise<{ model: string; error?: string }> {
    const key = apiKey.trim().replace(/\s+/g, '');
    const wanted = requested.trim();
    if (!key) return { model: wanted, error: 'Groq API key is not saved.' };
    const models = await listGroqChatModels(key);
    if (!models.length) {
      return { model: wanted, error: 'Groq API key was rejected or no chat model was returned.' };
    }
    if (wanted && models.includes(wanted)) return { model: wanted };
    const replacement = defaultGroqModel(models);
    if (wanted && wanted !== replacement) {
      return { model: replacement, error: `${wanted} is not available on this Groq key. Using ${replacement} instead.` };
    }
    return { model: replacement };
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
      const test = await generateGemini(
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
      const test = await generateGemini(
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
    if (process.env.NODE_ENV === 'production' && !settings.appSecret.trim()) {
      console.error('WhatsappService.handleWebhook: app secret is not configured');
      return 'forbidden';
    }
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
      ? `https://wa.me/${phone}?text=${encodeURIComponent('Hello')}`
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

  async deleteForAdmin(id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const { data, error } = await this.table.delete().eq('id', id).select('id');
    if (error) {
      console.error('WhatsappService.deleteForAdmin', error.message);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
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
      messages: chat.messages.map(({ id: messageId, role, text, at, sendError, aiError, replyBy }) => ({
        id: messageId,
        role,
        text,
        at,
        ...(sendError ? { sendError } : {}),
        ...(aiError ? { aiError } : {}),
        ...(replyBy ? { replyBy } : {}),
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

    await this.answerCustomer(settings, appended.row, message, assistantId, true);
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
    await this.answerCustomer(settings, row, message, assistantId, false);
  }

  /** Existing number gets one status template. A new number is answered by Navya. */
  private async answerCustomer(
    settings: WhatsappSettings,
    row: EnquiryRow,
    message: InboundWhatsappMessage,
    assistantId: string,
    rateLimit: boolean,
  ) {
    const route = await this.routeCustomer(message.phone, row.chat.leadNote, row.chat.messages);
    if (route.action === 'silent') return;
    if (route.action === 'template') {
      await this.storeAndSend(settings, row, message.profileName, assistantId, route.text, message.phoneNumberId);
      return;
    }
    const limited = rateLimit && !allowRateLimitedAction(`wa-in:${message.phone}`, 20, 10 * 60_000);
    const facts = collectChatFacts(row.chat.facts, row.chat.messages, message.profileName || row.chat.profileName);
    const reply = limited
      ? { text: 'Please wait a few minutes before sending more messages.' }
      : await this.buildReply(settings, row.chat.messages, message, facts);
    await this.storeAndSend(
      settings,
      row,
      message.profileName,
      assistantId,
      reply.text,
      message.phoneNumberId,
      reply.aiError,
      reply.replyBy,
    );
  }

  private async buildReply(
    settings: WhatsappSettings,
    history: ChatMessage[],
    message: InboundWhatsappMessage,
    facts: ChatFacts,
  ): Promise<{ text: string; aiError?: string; replyBy?: 'groq' | 'gemini' }> {
    const textLike = message.type === 'text' || message.type === 'button' || message.type === 'interactive';
    if (!textLike || !message.text) {
      return { text: 'Please send your question as a text message.' };
    }

    const greeted = history.some(
      (item) => item.role === 'assistant' && /navya|personal loan chahiye/i.test(item.text),
    );
    const closed = conversationClosed(history);
    if (nextMissingField(facts) === 'done') {
      return { text: closingReply(facts, message.profileName, closed) };
    }
    const nextAsk =
      scriptedNavyaReply(facts, message.profileName, greeted, closed) ||
      'Jo last detail pending hai woh bata dijiye, main aage check karti hoon.';

    if (!isSideQuestion(message.text)) {
      const scripted = scriptedNavyaReply(facts, message.profileName, greeted, closed);
      if (scripted) return { text: scripted };
    }

    if (!settings.groqApiKey && !settings.geminiApiKey) {
      return { text: nextAsk, aiError: 'No AI key is saved in Settings.' };
    }

    const note = this.customerNote(message, facts);
    const groqStop = new AbortController();
    const groqTask = settings.groqApiKey ? this.askGroq(settings, history, note, groqStop.signal) : null;
    if (!groqTask) {
      const gemini = await this.askGemini(settings, history, note);
      if (gemini.text) return { text: smoothReply(gemini.text), replyBy: 'gemini' };
      return { text: nextAsk, aiError: gemini.error || 'Gemini returned an empty reply.' };
    }
    if (!settings.geminiApiKey) {
      const groq = await groqTask;
      if (groq.text) return { text: smoothReply(groq.text), replyBy: 'groq' };
      return { text: nextAsk, aiError: groq.error || 'Groq returned an empty reply.' };
    }

    const quick = await Promise.race([
      groqTask.then((result) => ({ ...result, slow: false })),
      new Promise<{ text: string; error?: string; slow: boolean }>((resolve) => {
        setTimeout(() => resolve({ text: '', slow: true }), 1_500);
      }),
    ]);
    if (quick.text) return { text: smoothReply(quick.text), replyBy: 'groq' };

    const geminiStop = new AbortController();
    const geminiTask = this.askGemini(settings, history, note, geminiStop.signal);
    if (!quick.slow) {
      groqStop.abort();
      if (quick.error) console.error('WhatsappService.reply Groq failed, trying Gemini');
      const gemini = await geminiTask;
      if (gemini.text) return { text: smoothReply(gemini.text), replyBy: 'gemini' };
      return {
        text: nextAsk,
        aiError: [quick.error, gemini.error].filter(Boolean).join(' | ').slice(0, 500),
      };
    }

    console.error('WhatsappService.reply Groq slow, Gemini started');
    const winner = await firstAiReply([
      { task: groqTask, stop: () => groqStop.abort(), replyBy: 'groq' },
      { task: geminiTask, stop: () => geminiStop.abort(), replyBy: 'gemini' },
    ]);
    if (winner.text) return { text: smoothReply(winner.text), replyBy: winner.replyBy };
    return { text: nextAsk, aiError: winner.error || 'AI returned an empty reply.' };
  }

  private async askGroq(
    settings: WhatsappSettings,
    history: ChatMessage[],
    note: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; error?: string }> {
    const key = settings.groqApiKey.trim().replace(/\s+/g, '');
    const contents = geminiContents(history).map((turn) => ({
      role: turn.role === 'model' ? ('assistant' as const) : ('user' as const),
      text: turn.parts.map((part) => part.text).join('\n'),
    }));
    if (!key) return { text: '', error: 'Groq API key is not saved.' };
    if (contents.length === 0) return { text: '', error: 'No customer text to send to Groq.' };

    const system = navyaInstruction(note);
    const configured = settings.groqModel.trim() || defaultGroqModel([]);
    const selected = await generateGroq(key, configured, system, contents, false, signal);
    if (selected.text) return { text: selected.text };
    return { text: '', error: selected.error || 'Groq returned an empty reply.' };
  }

  private customerNote(message: InboundWhatsappMessage, facts: ChatFacts): string {
    const knownName = message.profileName.trim();
    const base = knownName
      ? `Customer WhatsApp number: ${message.phone}. Profile name on WhatsApp: ${knownName}. Confirm this name; do not ask for the phone number.`
      : `Customer WhatsApp number: ${message.phone}. No profile name. Ask their name when that step comes. Do not ask for the phone number.`;
    return `${base}\n\n${factsInstruction(facts, nextMissingField(facts))}`;
  }

  /**
   * Existing lead: one fixed status message, then silence. New lead: Navya may chat.
   * Leads are only read. A failed lookup is not saved, so the next message can try again.
   */
  private async routeCustomer(
    phone: string,
    savedLeadNote: string | undefined,
    messages: ChatMessage[],
  ): Promise<{ action: 'ai' } | { action: 'silent' } | { action: 'template'; text: string }> {
    if (savedLeadNote === '') return { action: 'ai' };
    if (savedLeadNote?.startsWith(EXISTING_MARK)) {
      const text = savedLeadNote.slice(EXISTING_MARK.length).trim();
      const told = messages.some((item) => item.role === 'assistant' && item.text.trim() === text);
      return told || !text ? { action: 'silent' } : { action: 'template', text };
    }

    const template = await this.existingStatusTemplate(phone);
    if (template === null) return { action: 'template', text: STATUS_LOOKUP_RETRY };

    await this.rememberLeadNote(phone, template ? `${EXISTING_MARK}${template}` : '', savedLeadNote !== undefined);
    return template ? { action: 'template', text: template } : { action: 'ai' };
  }

  /** Saves the first lookup so later replies do not query leads again. */
  private async rememberLeadNote(phone: string, leadNote: string, overwrite = false): Promise<void> {
    const key = canonicalWhatsappPhone(phone);
    const current = await this.readByPhone(key);
    if (!current) return;
    const prev = current.chat.leadNote;
    if (!overwrite && prev !== undefined) return;
    if (overwrite && (prev === '' || prev?.startsWith(EXISTING_MARK))) return;
    const chat: ChatDoc = { ...current.chat, leadNote: leadNote.slice(0, 1500) };
    const { error } = await this.table
      .update({ chat, updated_at: new Date().toISOString() })
      .eq('id', current.id)
      .eq('updated_at', current.updated_at);
    if (error) console.error('WhatsappService.rememberLeadNote', error.message);
  }

  /** Read-only. Returns the fixed status message, "" for a new number, or null if the lookup failed. */
  private async existingStatusTemplate(phone: string): Promise<string | null> {
    const canonical = canonicalWhatsappPhone(phone);
    const ten = canonical.startsWith('91') && canonical.length === 12 ? canonical.slice(2) : canonical;
    if (!/^[6-9]\d{9}$/.test(ten)) return '';

    const { data, error } = await this.supabase
      .from(TABLE_LEADS)
      .select('full_name, mobile_number, category, ins_type, status, pan, is_active')
      .in('mobile_number', [ten, `91${ten}`])
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      console.error('WhatsappService.existingStatusTemplate', error.message);
      return null;
    }

    const rows = ((data as Record<string, unknown>[]) ?? []).filter((row) => {
      const stored = String(row.mobile_number ?? '').replace(/\D/g, '');
      return stored.endsWith(ten) && !isDraftLead(row);
    });
    if (!rows.length) return '';

    const name = String(rows.find((row) => String(row.full_name ?? '').trim())?.full_name ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    const latest = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const category = normalizeStoredCategory(String(row.category ?? ''));
      if (!category || latest.has(category)) continue;
      latest.set(category, row);
    }
    if (!latest.size) return '';

    const lines = [...latest.values()].map((row) => ({
      product: productLabel(row),
      status: statusLabel(row.status),
    }));
    return existingStatusText(name, lines);
  }

  private async askGemini(
    settings: WhatsappSettings,
    history: ChatMessage[],
    note: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; error?: string }> {
    const key = settings.geminiApiKey.trim().replace(/\s+/g, '');
    const contents = geminiContents(history);
    if (!key) return { text: '', error: 'Gemini API key is not saved.' };
    if (contents.length === 0) return { text: '', error: 'No customer text to send to Gemini.' };

    const system = navyaInstruction(note);
    const configured = settings.geminiModel.trim();
    const errors: string[] = [];
    if (configured) {
      const selected = await generateGemini(key, configured, system, contents, true, false, signal);
      if (selected.text) return { text: selected.text };
      return { text: '', error: selected.error || 'Gemini returned an empty reply.' };
    }

    const available = await listGeminiChatModels(key);
    const fallback = available.find(Boolean) || '';
    if (fallback) {
      const result = await generateGemini(key, fallback, system, contents, true, false, signal);
      if (result.text) return { text: result.text };
      if (result.error) errors.push(result.error);
    }
    return { text: '', error: errors.join(' | ').slice(0, 500) || 'Gemini returned an empty reply.' };
  }


  private async storeAndSend(
    settings: WhatsappSettings,
    row: EnquiryRow,
    profileName: string,
    assistantId: string,
    text: string,
    waPhoneNumberId = '',
    aiError = '',
    replyBy?: 'groq' | 'gemini',
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
          ...(replyBy ? { replyBy } : {}),
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
          text: { preview_url: false, body: text.replace(/\uFFFD/g, '').trim().slice(0, 4000) },
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

      const messages = [...(current?.chat.messages ?? []), message].slice(-MAX_MESSAGES);
      const facts = collectChatFacts(current?.chat.facts, messages, profileName.trim() || current?.chat.profileName || '');
      const chat: ChatDoc = {
        profileName: profileName.trim() || current?.chat.profileName || '',
        waPhoneNumberId: (waPhoneNumberId || current?.chat.waPhoneNumberId || '').replace(/\D/g, '').slice(0, 30),
        messages,
        ...(current?.chat.leadNote !== undefined ? { leadNote: current.chat.leadNote } : {}),
        facts,
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
    const messages = [...latest.chat.messages, message].slice(-MAX_MESSAGES);
    const chat: ChatDoc = {
      profileName: profileName.trim() || latest.chat.profileName || '',
      waPhoneNumberId: (waPhoneNumberId || latest.chat.waPhoneNumberId || '').replace(/\D/g, '').slice(0, 30),
      messages,
      ...(latest.chat.leadNote !== undefined ? { leadNote: latest.chat.leadNote } : {}),
      facts: collectChatFacts(latest.chat.facts, messages, profileName.trim() || latest.chat.profileName || ''),
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
