import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_LEADS, TABLE_WP_ENQUIRIES } from '../common/constants';
import { isDraftLead, normalizeStoredCategory, productLabel, statusLabel } from '../leads/lead-present';
import { SUPABASE_CLIENT } from '../config/supabase';
import { allowRateLimitedAction } from '../security/rate-limit';
import { canonicalWhatsappPhone, extractInboundMessages, InboundWhatsappMessage } from './whatsapp-inbound';
import { WhatsappSettings, WhatsappSettingsService } from './whatsapp-settings.service';
import { whatsappSignatureOk } from './whatsapp-verify';
import {
  alreadyWelcomed,
  insuranceText,
  personalLoanText,
  productChoice,
  welcomeInteractive,
  welcomeText,
} from './whatsapp-templates';

const GRAPH_VERSION = 'v21.0';
const MAX_MESSAGES = 1000;
const EXISTING_MARK = 'EXISTING\n';
const STATUS_LOOKUP_RETRY =
  'Namaste ji 🙏 Aapki application ka status abhi nahi nikal paaya. Kripya thodi der baad ek baar message karein.';
const MAX_ADMIN_FILE = 16 * 1024 * 1024;

function existingStatusText(name: string, lines: { product: string; status: string }[]): string {
  const who = name ? `${name} ji` : 'ji';
  const body =
    lines.length === 1
      ? `Aapki ${lines[0].product} application ka status: ${lines[0].status}.`
      : `Aapki applications ka status:\n${lines.map((line) => `${line.product}: ${line.status}`).join('\n')}`;
  return `Namaste ${who} 🙏\n\n${body}\n\nApni Zaroorat team isi WhatsApp number pe aapko update degi.`;
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

function graphWaType(mime: string): NonNullable<ChatMessage['waType']> {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function graphMessageBody(phone: string, message: ChatMessage): Record<string, unknown> | null {
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
  };
  if (message.waType === 'interactive' || message.kind === 'welcome') {
    return { ...base, ...welcomeInteractive(message.text || welcomeText('')) };
  }
  if (message.mediaId && (message.waType === 'image' || message.waType === 'document' || message.waType === 'audio' || message.waType === 'video')) {
    const kind = message.waType;
    const media: Record<string, string> = { id: message.mediaId };
    if (message.text && kind !== 'audio') media.caption = message.text.slice(0, 1024);
    if (kind === 'document' && message.filename) media.filename = message.filename;
    return { ...base, type: kind, [kind]: media };
  }
  const body = message.text.replace(/\uFFFD/g, '').trim().slice(0, 4000);
  if (!body) return null;
  return {
    ...base,
    type: 'text',
    text: { preview_url: true, body },
  };
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
  replyBy?: 'template' | 'admin';
  kind?: 'welcome' | 'personal_loan' | 'insurance' | 'status' | 'admin';
  waType?: 'text' | 'interactive' | 'image' | 'document' | 'audio' | 'video';
  mediaId?: string;
  filename?: string;
  mime?: string;
};

type ChatDoc = {
  profileName: string;
  waPhoneNumberId: string;
  messages: ChatMessage[];
  /** Empty means a new customer. A saved status means that message was already sent. */
  leadNote?: string;
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
  messages: { id: string; role: 'user' | 'assistant'; text: string; at: string; sendError?: string; replyBy?: string; kind?: string; waType?: string; filename?: string }[];
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
      ? (value as { profileName?: unknown; messages?: unknown; waPhoneNumberId?: unknown; leadNote?: unknown })
      : {};
    const messages = Array.isArray(obj.messages) ? obj.messages : [];
    const clean: ChatMessage[] = [];
    for (const item of messages) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Partial<ChatMessage>;
      const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : null;
      const id = String(row.id ?? '').trim();
      if (!role || !id) continue;
      const rawBy = String((row as { replyBy?: string }).replyBy ?? '');
      const replyBy = rawBy === 'admin' ? 'admin' : rawBy === 'template' || rawBy === 'groq' || rawBy === 'gemini' ? 'template' : undefined;
      const kind =
        row.kind === 'welcome' ||
        row.kind === 'personal_loan' ||
        row.kind === 'insurance' ||
        row.kind === 'status' ||
        row.kind === 'admin'
          ? row.kind
          : undefined;
      const waType =
        row.waType === 'interactive' ||
        row.waType === 'image' ||
        row.waType === 'document' ||
        row.waType === 'audio' ||
        row.waType === 'video'
          ? row.waType
          : row.waType === 'text'
            ? 'text'
            : undefined;
      clean.push({
        id: id.slice(0, 200),
        role,
        text: String(row.text ?? '').slice(0, 4000),
        at: String(row.at ?? ''),
        ...(row.sent ? { sent: true } : {}),
        ...(row.sending ? { sending: true } : {}),
        ...(row.sendingAt ? { sendingAt: String(row.sendingAt) } : {}),
        ...(row.sendError ? { sendError: String(row.sendError).slice(0, 500) } : {}),
        ...(replyBy ? { replyBy } : {}),
        ...(kind ? { kind } : {}),
        ...(waType ? { waType } : {}),
        ...(row.mediaId ? { mediaId: String(row.mediaId).slice(0, 200) } : {}),
        ...(row.filename ? { filename: String(row.filename).slice(0, 180) } : {}),
        ...(row.mime ? { mime: String(row.mime).slice(0, 80) } : {}),
      });
    }
    return {
      profileName: String(obj.profileName ?? '').slice(0, 120),
      waPhoneNumberId: String(obj.waPhoneNumberId ?? '').replace(/\D/g, '').slice(0, 30),
      messages: clean.slice(-MAX_MESSAGES),
      ...(typeof obj.leadNote === 'string' ? { leadNote: obj.leadNote.slice(0, 1500) } : {}),
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
      messages: chat.messages.map((item) => ({
        id: item.id,
        role: item.role,
        text: item.text,
        at: item.at,
        ...(item.sendError ? { sendError: item.sendError } : {}),
        ...(item.replyBy ? { replyBy: item.replyBy } : {}),
        ...(item.kind ? { kind: item.kind } : {}),
        ...(item.waType ? { waType: item.waType } : {}),
        ...(item.filename ? { filename: item.filename } : {}),
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
    await this.flushUnsent(settings, message.phone);
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
      await this.deliver(settings, row.phone, assistant);
      return;
    }
    await this.answerCustomer(settings, row, message, assistantId, false);
  }

  /** Existing lead: one status template. New number: welcome buttons or product template. Else wait for admin. */
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
      await this.storeAndSend(settings, row, message.profileName, {
        id: assistantId,
        role: 'assistant',
        text: route.text,
        at: new Date().toISOString(),
        replyBy: 'template',
        kind: 'status',
        waType: 'text',
      });
      return;
    }
    if (rateLimit && !allowRateLimitedAction(`wa-in:${message.phone}`, 20, 10 * 60_000)) {
      await this.storeAndSend(settings, row, message.profileName, {
        id: assistantId,
        role: 'assistant',
        text: 'Please wait a few minutes before sending more messages.',
        at: new Date().toISOString(),
        replyBy: 'template',
        waType: 'text',
      });
      return;
    }
    const name = message.profileName || row.chat.profileName;
    const choice = productChoice(message.buttonId, message.text);
    if (choice === 'personal_loan') {
      await this.storeAndSend(settings, row, name, {
        id: assistantId,
        role: 'assistant',
        text: personalLoanText(name),
        at: new Date().toISOString(),
        replyBy: 'template',
        kind: 'personal_loan',
        waType: 'text',
      });
      return;
    }
    if (choice === 'insurance') {
      await this.storeAndSend(settings, row, name, {
        id: assistantId,
        role: 'assistant',
        text: insuranceText(name),
        at: new Date().toISOString(),
        replyBy: 'template',
        kind: 'insurance',
        waType: 'text',
      });
      return;
    }
    if (!alreadyWelcomed(row.chat.messages)) {
      await this.storeAndSend(settings, row, name, {
        id: assistantId,
        role: 'assistant',
        text: welcomeText(name),
        at: new Date().toISOString(),
        replyBy: 'template',
        kind: 'welcome',
        waType: 'interactive',
      });
    }
  }

  /**
   * Existing lead: one fixed status message, then silence. New lead: templates only.
   * Leads are only read. A failed lookup is not saved, so the next message can try again.
   */
  private async routeCustomer(
    phone: string,
    savedLeadNote: string | undefined,
    messages: ChatMessage[],
  ): Promise<{ action: 'new' } | { action: 'silent' } | { action: 'template'; text: string }> {
    if (savedLeadNote === '') return { action: 'new' };
    if (savedLeadNote?.startsWith(EXISTING_MARK)) {
      const text = savedLeadNote.slice(EXISTING_MARK.length).trim();
      const told = messages.some((item) => item.role === 'assistant' && item.text.trim() === text);
      return told || !text ? { action: 'silent' } : { action: 'template', text };
    }

    const template = await this.existingStatusTemplate(phone);
    if (template === null) return { action: 'template', text: STATUS_LOOKUP_RETRY };

    await this.rememberLeadNote(phone, template ? `${EXISTING_MARK}${template}` : '', savedLeadNote !== undefined);
    return template ? { action: 'template', text: template } : { action: 'new' };
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

  async adminReply(
    id: string,
    text: string,
    file?: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ): Promise<{ ok: boolean; error?: string; data?: WhatsappEnquiryDetail }> {
    const row = await this.getRowById(id);
    if (!row) return { ok: false, error: 'Chat not found.' };
    const settings = await this.settings.getEffective();
    const caption = text.trim().slice(0, 4000);
    const assistantId = `admin:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const message: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      text: caption || (file ? file.originalname : ''),
      at: new Date().toISOString(),
      replyBy: 'admin',
      kind: 'admin',
      waType: 'text',
    };
    if (file) {
      if (file.size > MAX_ADMIN_FILE) return { ok: false, error: 'File is too large (max 16 MB).' };
      const uploaded = await this.uploadWhatsappMedia(settings, row.chat.waPhoneNumberId, file);
      if (!uploaded.id) return { ok: false, error: uploaded.error || 'Could not upload this file to WhatsApp.' };
      const waType = graphWaType(file.mimetype);
      message.waType = waType;
      message.mediaId = uploaded.id;
      message.filename = file.originalname.slice(0, 180);
      message.mime = file.mimetype.slice(0, 80);
      if (!message.text) message.text = waType === 'image' ? 'Photo' : file.originalname;
    } else if (!caption) {
      return { ok: false, error: 'Type a message or attach a file.' };
    }
    await this.storeAndSend(settings, row, row.chat.profileName, message);
    const data = await this.getForAdmin(row.id);
    return data ? { ok: true, data } : { ok: false, error: 'Sent, but chat could not be reloaded.' };
  }

  private async getRowById(id: string): Promise<EnquiryRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data, error } = await this.table
      .select('id, phone, chat, last_chat_at, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error('WhatsappService.getRowById', error.message);
      return null;
    }
    const row = data as EnquiryRow;
    return { ...row, chat: asChat(row.chat) };
  }

  private async storeAndSend(
    settings: WhatsappSettings,
    row: EnquiryRow,
    profileName: string,
    message: ChatMessage,
  ) {
    const already = row.chat.messages.some((item) => item.id === message.id);
    if (!already) {
      const appended = await this.appendMessage(row.phone, profileName, message, row.chat.waPhoneNumberId);
      if (!appended) return;
      row = appended.row;
    }
    const saved = row.chat.messages.find((item) => item.id === message.id) || message;
    await this.deliver(settings, row.phone, saved);
  }

  /** Resend replies that were saved but never delivered (Meta will not always retry). */
  private async flushUnsent(settings: WhatsappSettings, phone: string) {
    const row = await this.readByPhone(phone);
    if (!row) return;
    const pending = row.chat.messages.filter((item) => item.role === 'assistant' && !item.sent).slice(-5);
    for (const item of pending) {
      await this.deliver(settings, phone, item);
    }
  }

  /** Only one worker sends a given reply. A stale claim can be taken again after a crash. */
  private async deliver(settings: WhatsappSettings, phone: string, message: ChatMessage) {
    const claimed = await this.claimSend(phone, message.id);
    if (!claimed) return;
    const row = await this.readByPhone(phone);
    const result = await this.sendWhatsapp(settings, phone, message, row?.chat.waPhoneNumberId || '');
    if (result.ok) await this.markSent(phone, message.id);
    else {
      await this.releaseSend(phone, message.id);
      if (result.error) await this.noteSendError(phone, message.id, result.error);
    }
  }

  private async sendWhatsapp(
    settings: WhatsappSettings,
    phone: string,
    message: ChatMessage,
    waPhoneNumberId = '',
  ): Promise<{ ok: boolean; error?: string }> {
    const token = settings.accessToken.trim().replace(/^bearer\s+/i, '').trim();
    const fromId = (waPhoneNumberId || settings.phoneNumberId).replace(/\D/g, '');
    if (!token || !fromId) {
      const error = !token
        ? 'WhatsApp access token is missing in Settings.'
        : 'WhatsApp phone number ID is missing in Settings.';
      console.error('WhatsappService.sendWhatsapp', error);
      return { ok: false, error };
    }
    const payload = graphMessageBody(phone, message);
    if (!payload) return { ok: false, error: 'Nothing to send.' };
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(fromId)}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const error = await metaErrorText(res);
        console.error('WhatsappService.sendWhatsapp', error);
        return { ok: false, error };
      }
      return { ok: true };
    } catch (error) {
      const fail = error instanceof Error ? error.message : 'WhatsApp send failed';
      console.error('WhatsappService.sendWhatsapp', fail);
      return { ok: false, error: fail.slice(0, 300) };
    }
  }

  private async uploadWhatsappMedia(
    settings: WhatsappSettings,
    waPhoneNumberId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<{ id: string; error?: string }> {
    const token = settings.accessToken.trim().replace(/^bearer\s+/i, '').trim();
    const fromId = (waPhoneNumberId || settings.phoneNumberId).replace(/\D/g, '');
    if (!token || !fromId) return { id: '', error: 'WhatsApp access token or phone number ID is missing.' };
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', file.mimetype);
    form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);
    try {
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(fromId)}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return { id: '', error: await metaErrorText(res) };
      const data = (await res.json()) as { id?: string };
      return data.id ? { id: data.id } : { id: '', error: 'WhatsApp did not return a media id.' };
    } catch (error) {
      return { id: '', error: error instanceof Error ? error.message : 'Media upload failed' };
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
      const chat: ChatDoc = {
        profileName: profileName.trim() || current?.chat.profileName || '',
        waPhoneNumberId: (waPhoneNumberId || current?.chat.waPhoneNumberId || '').replace(/\D/g, '').slice(0, 30),
        messages,
        ...(current?.chat.leadNote !== undefined ? { leadNote: current.chat.leadNote } : {}),
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
