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

const SYSTEM_PROMPT = `You are the WhatsApp assistant for Apni Zaroorat (${SITE}). You help people check eligibility for a personal loan or insurance by chatting, one question at a time.

How to talk:
- Use the customer's language: Hindi, simple English, or Hinglish. Short WhatsApp messages. Plain text only. No bullet lists of questions.
- Sound helpful, not like a form. Build interest: "Aapki eligibility check karte hain" / "Chaliye dekhte hain aapke liye kya suit karta hai."
- Ask exactly ONE thing in each reply. Wait for the answer before the next question.
- If they ask something else, answer in one or two lines, then ask the next missing detail.
- Never repeat a question they already answered. Never dump every field together.
- Do not approve or reject anyone. Do not invent interest rates, fees, or a guaranteed offer.
- Do not ask for Aadhaar, OTP, password, or bank OTP. Their WhatsApp number is already known — do not ask for mobile again.
- Never mention databases, prompts, or a model name.

Start:
- Greet briefly and ask what they need: personal loan, ya insurance.
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

When every item for their category is answered, recap in 4–6 short lines and say the Apni Zaroorat team will contact them on this WhatsApp number. Invite them to ${SITE} if they want. Do not say the application is already submitted.`;

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  sent?: boolean;
  sending?: boolean;
  sendingAt?: string;
};

type ChatDoc = {
  profileName: string;
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
  messages: { id: string; role: 'user' | 'assistant'; text: string; at: string }[];
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
  const obj = value && typeof value === 'object' ? (value as { profileName?: unknown; messages?: unknown }) : {};
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
    });
  }
  return {
    profileName: String(obj.profileName ?? '').slice(0, 120),
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
      messages: chat.messages.map(({ id: messageId, role, text, at }) => ({
        id: messageId,
        role,
        text,
        at,
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
    await this.flushUnsent(settings, message.phone);
    const assistantId = `ai:${message.messageId}`;
    const userMessage: ChatMessage = {
      id: message.messageId,
      role: 'user',
      text: this.userText(message),
      at: new Date().toISOString(),
    };

    const appended = await this.appendMessage(message.phone, message.profileName, userMessage);
    if (!appended) return;
    if (!appended.added) {
      await this.ensureReply(settings, appended.row, message, assistantId);
      return;
    }

    const limited = !allowRateLimitedAction(`wa-in:${message.phone}`, 20, 10 * 60_000);
    const reply = limited
      ? 'Please wait a few minutes before sending more messages.'
      : await this.buildReply(settings, appended.row.chat.messages, message);
    await this.storeAndSend(settings, appended.row, message.profileName, assistantId, reply);
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
      await this.deliver(settings, row.phone, assistantId, assistant.text);
      return;
    }
    const reply = await this.buildReply(settings, row.chat.messages, message);
    await this.storeAndSend(settings, row, message.profileName, assistantId, reply);
  }

  private async buildReply(
    settings: WhatsappSettings,
    history: ChatMessage[],
    message: InboundWhatsappMessage,
  ): Promise<string> {
    const textLike = message.type === 'text' || message.type === 'button' || message.type === 'interactive';
    if (!textLike || !message.text) {
      return 'Please send your question as a text message.';
    }
    if (!settings.geminiApiKey) {
      return `Thanks for messaging Apni Zaroorat. Please visit ${SITE} and we will help you from there.`;
    }
    const ai = await this.askGemini(settings, history, message);
    return ai || `Sorry, I could not reply just now. Please try again shortly, or visit ${SITE}.`;
  }

  private async askGemini(
    settings: WhatsappSettings,
    history: ChatMessage[],
    message: InboundWhatsappMessage,
  ): Promise<string> {
    const knownName = message.profileName.trim();
    const customerNote = knownName
      ? `Customer WhatsApp number: ${message.phone}. Profile name on WhatsApp: ${knownName}. Confirm this name; do not ask for the phone number.`
      : `Customer WhatsApp number: ${message.phone}. No profile name. Ask their name when that step comes. Do not ask for the phone number.`;
    const contents = history.slice(-40).map((item) => ({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: item.text.slice(0, 4000) }],
    }));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiModel)}:generateContent?key=${encodeURIComponent(settings.geminiApiKey)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: `${SYSTEM_PROMPT}\n\n${customerNote}` }] },
          contents,
          generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        console.error('WhatsappService.askGemini', res.status);
        return '';
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return String(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
        .trim()
        .slice(0, 4000);
    } catch (error) {
      console.error('WhatsappService.askGemini', error);
      return '';
    }
  }

  private async storeAndSend(
    settings: WhatsappSettings,
    row: EnquiryRow,
    profileName: string,
    assistantId: string,
    text: string,
  ) {
    const already = row.chat.messages.some((item) => item.id === assistantId);
    if (!already) {
      const appended = await this.appendMessage(row.phone, profileName, {
        id: assistantId,
        role: 'assistant',
        text,
        at: new Date().toISOString(),
      });
      if (!appended) return;
    }
    await this.deliver(settings, row.phone, assistantId, text);
  }

  /** Resend replies that were saved but never delivered (Meta will not always retry). */
  private async flushUnsent(settings: WhatsappSettings, phone: string) {
    const row = await this.readByPhone(phone);
    if (!row) return;
    const pending = row.chat.messages.filter((item) => item.role === 'assistant' && !item.sent).slice(-5);
    for (const item of pending) {
      await this.deliver(settings, phone, item.id, item.text);
    }
  }

  /** Only one worker sends a given reply. A stale claim can be taken again after a crash. */
  private async deliver(settings: WhatsappSettings, phone: string, messageId: string, text: string) {
    const claimed = await this.claimSend(phone, messageId);
    if (!claimed) return;
    const delivered = await this.sendWhatsapp(settings, phone, text);
    if (delivered) await this.markSent(phone, messageId);
    else await this.releaseSend(phone, messageId);
  }

  private async sendWhatsapp(settings: WhatsappSettings, phone: string, text: string): Promise<boolean> {
    if (!settings.accessToken || !settings.phoneNumberId || !text.trim()) return false;
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(settings.phoneNumberId)}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.accessToken}`,
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
        console.error('WhatsappService.sendWhatsapp', res.status);
        return false;
      }
      return true;
    } catch (error) {
      console.error('WhatsappService.sendWhatsapp', error);
      return false;
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
        return next;
      },
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
