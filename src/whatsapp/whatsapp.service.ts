import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_LEADS, TABLE_WP_ENQUIRIES } from '../common/constants';
import { LEAD_DRAFT_FULL_NAME } from '../leads/lead-draft';
import { normalizeStoredCategory } from '../leads/lead-present';
import { SUPABASE_CLIENT } from '../config/supabase';
import { isGreeting, pickBotReply } from './whatsapp-bot-rules';
import { allowRateLimitedAction } from '../security/rate-limit';
import {
  asChat,
  emptyFlow,
  MAX_MESSAGES,
  type ChatDoc,
  type ChatMessage,
  type EnquiryRow,
  type FlowMem,
  type WhatsappEnquiryDetail,
  type WhatsappEnquiryListItem,
} from './whatsapp-chat';
import {
  GRAPH_UPLOAD_MS,
  GRAPH_VERSION,
  graphMessageBody,
  graphWaType,
  isGraphTimeout,
  metaErrorText,
  postGraphMessage,
} from './whatsapp-graph';
import { adminTargetPhone, canonicalWhatsappPhone, extractInboundMessages, InboundWhatsappMessage } from './whatsapp-inbound';
import { kycChatText, kycGraphPayload, KYC_START_BTN, KYC_STATUS_BTN, KYC_TEMPLATE_LANG } from './whatsapp-kyc';
import { WhatsappSettings, WhatsappSettingsService } from './whatsapp-settings.service';
import { whatsappSignatureOk } from './whatsapp-verify';
import {
  alreadyKycDocsAsked,
  alreadyKycStarted,
  alreadyOfferedProduct,
  alreadyThanked,
  alreadyWelcomed,
  isKycStartClick,
  isKycStatusClick,
  kycDocsRequestText,
  statusCheckText,
  insuranceText,
  personalLoanText,
  productChoice,
  productImageFile,
  productImageFilename,
  productImageUrl,
  withCachedProductImage,
  thankYouText,
  welcomeText,
  type ProductChoice,
} from './whatsapp-templates';

export type { WhatsappEnquiryDetail, WhatsappEnquiryListItem } from './whatsapp-chat';

const MAX_ADMIN_FILE = 16 * 1024 * 1024;
const ADMIN_UPLOAD_MIME =
  /^(image\/(jpeg|jpg|png|webp|gif)|audio\/(aac|mp4|mpeg|amr|ogg|opus)|video\/(mp4|3gpp|quicktime)|application\/pdf|text\/(plain|csv)|application\/msword|application\/vnd\.(ms-|openxmlformats-)|application\/zip)/i;

@Injectable()
export class WhatsappService implements OnModuleInit {
  private linkCache: { until: number; url: string | null } | null = null;
  private mediaIdCache = new Map<string, { id: string; until: number }>();
  private mediaUploadInflight = new Map<string, Promise<string>>();
  private sentIds = new Set<string>();
  private inflight = new Set<string>();
  private flowMem = new Map<string, FlowMem>();
  private persistTail = new Map<string, Promise<void>>();
  private kycTemplateSent = new Set<string>();

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly settings: WhatsappSettingsService,
  ) {}

  private get table() {
    return this.supabase.from(TABLE_WP_ENQUIRIES);
  }

  async onModuleInit() {
    const settings = await this.settings.getEffective();
    this.warmTemplateMedia(settings);
  }

  /** Fire-and-forget after OTP. Login must not wait on Meta. */
  notifyAfterOtpVerified(mobile: string): void {
    const ten = String(mobile ?? '').replace(/\D/g, '').slice(-10);
    const phone = canonicalWhatsappPhone(ten);
    if (!/^[6-9]\d{9}$/.test(ten) || this.kycTemplateSent.has(phone)) return;
    void this.sendKycForVerifiedMobile(ten, phone).catch((error) => {
      console.error('WhatsappService.notifyAfterOtpVerified', error);
    });
  }

  notifyApplicationKycStart(input: {
    leadId?: string;
    phone: string;
    name: string;
    category?: string;
  }): void {
    const category = normalizeStoredCategory(String(input.category ?? ''));
    if (category !== 'personal_loan' && category !== 'insurance') return;
    void this.dispatchKycTemplate(
      canonicalWhatsappPhone(input.phone),
      String(input.name ?? ''),
      category,
    ).catch((error) => {
      console.error('WhatsappService.notifyApplicationKycStart', error);
    });
  }

  async handleWebhook(rawBody: Buffer, signatureHeader?: string): Promise<'ok' | 'forbidden'> {
    const settings = this.settings.peekEffective() ?? (await this.settings.getEffective());
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

    const inbound = extractInboundMessages(payload);
    this.dispatchInbound(settings, inbound);
    return 'ok';
  }

  private dispatchInbound(settings: WhatsappSettings, inbound: InboundWhatsappMessage[]) {
    for (const message of inbound) {
      try {
        this.handleInbound(settings, message);
      } catch (error) {
        console.error('WhatsappService.handleInbound', message.messageId, error);
      }
    }
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
      .order('last_chat_at', { ascending: false, nullsFirst: false })
      .limit(80);

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
        lastMessage:
          last?.text?.trim() ||
          (last?.waType === 'image' ? 'Photo' : last?.filename || (last?.waType === 'document' ? 'File' : last?.waType) || ''),
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
        ...(item.mime ? { mime: item.mime } : {}),
        ...(item.kind === 'kyc' ? { buttons: [KYC_START_BTN, KYC_STATUS_BTN] } : {}),
        ...(item.kind === 'welcome' ? { buttons: ['Personal Loan', 'Insurance'] } : {}),
        ...(item.mediaId || item.filename === 'wa_ins.jpg' || item.filename === 'wa_loa.jpg' ? { hasMedia: true } : {}),
      })),
    };
  }

  async adminMedia(
    enquiryId: string,
    messageId: string,
  ): Promise<{ buffer: Buffer; mime: string; filename?: string } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(enquiryId)) return null;
    const id = String(messageId ?? '').trim().slice(0, 200);
    if (!id) return null;
    const row = await this.getRowById(enquiryId);
    if (!row) return null;
    const item = row.chat.messages.find((message) => message.id === id);
    if (!item) return null;

    if (!item.mediaId && (item.filename === 'wa_ins.jpg' || item.filename === 'wa_loa.jpg')) {
      const path = this.templateImagePath(item.filename);
      if (!path) return null;
      return { buffer: readFileSync(path), mime: 'image/jpeg', filename: item.filename };
    }
    if (!item.mediaId) return null;

    const settings = await this.settings.getEffective();
    const token = settings.accessToken.trim().replace(/^bearer\s+/i, '').trim();
    if (!token) return null;
    try {
      const metaRes = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(item.mediaId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!metaRes.ok) return null;
      const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
      const url = String(meta.url ?? '').trim();
      if (!/^https:\/\//i.test(url)) return null;
      const bin = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'ApniZarooratWhatsApp/1.0',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!bin.ok) return null;
      const buffer = Buffer.from(await bin.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_ADMIN_FILE) return null;
      const mime = String(item.mime || meta.mime_type || bin.headers.get('content-type') || 'application/octet-stream').slice(0, 80);
      return { buffer, mime, filename: item.filename };
    } catch (error) {
      console.error('WhatsappService.adminMedia', error);
      return null;
    }
  }

  private userText(message: InboundWhatsappMessage): string {
    const textLike = message.type === 'text' || message.type === 'button' || message.type === 'interactive';
    if (textLike && message.text) return message.text;
    if (textLike) return '[empty message]';
    return `[${message.type} message]`;
  }

  private inboundUserMessage(message: InboundWhatsappMessage): ChatMessage {
    return {
      id: message.messageId,
      role: 'user',
      text: message.text || (message.waType === 'image' ? 'Photo' : message.filename || message.waType || this.userText(message)),
      at: new Date().toISOString(),
      ...(message.waType ? { waType: message.waType } : {}),
      ...(message.mediaId ? { mediaId: message.mediaId } : {}),
      ...(message.mime ? { mime: message.mime } : {}),
      ...(message.filename ? { filename: message.filename } : {}),
    };
  }

  private handleInbound(settings: WhatsappSettings, message: InboundWhatsappMessage) {
    const assistantId = `ai:${message.messageId}`;
    if (this.sentIds.has(assistantId) || this.inflight.has(message.messageId)) return;
    this.inflight.add(message.messageId);
    try {
      const phone = canonicalWhatsappPhone(message.phone);
      const kycClick = isKycStartClick(message.buttonId, message.text);
      const statusClick = isKycStatusClick(message.buttonId, message.text);
      if (kycClick || statusClick) this.seedKycFlow(phone);
      else this.ensureFlowFast(phone);

      const seen = this.flowMem.get(phone)?.ids;
      if (seen?.has(message.messageId) || seen?.has(assistantId)) return;

      const userMessage = this.inboundUserMessage(message);
      const choice = productChoice(message.buttonId, message.text);
      let reply = this.decideReply(phone, message, assistantId);
      if (
        reply &&
        reply.kind !== 'welcome' &&
        !choice &&
        !kycClick &&
        !statusClick &&
        !isGreeting(message.text) &&
        !allowRateLimitedAction(`wa-in:${phone}`, 20, 10 * 60_000)
      ) {
        reply = {
          id: assistantId,
          role: 'assistant',
          text: 'Please wait a few minutes before sending more messages.',
          at: new Date().toISOString(),
          replyBy: 'template',
          waType: 'text',
        };
      }

      this.rememberIds(phone, [userMessage.id, ...(reply ? [reply.id] : [])]);
      if (reply) this.noteFlow(phone, reply);

      if (reply) {
        reply.sent = true;
        void this.deliverBotReply(settings, phone, reply, message.phoneNumberId);
      }

      this.queuePersist(phone, () =>
        this.persistInbound(phone, message.profileName, userMessage, reply, message.phoneNumberId),
      );
    } finally {
      this.inflight.delete(message.messageId);
    }
  }

  /** KYC Start / Status check: no DB wait. Does not count as Namaste welcome. */
  private seedKycFlow(phone: string) {
    const seed = this.flowMem.get(phone) || emptyFlow();
    if (!seed.ids) seed.ids = new Set();
    seed.kyc = true;
    this.flowMem.set(phone, seed);
  }

  /** Reply uses memory only. History loads after the Graph POST has started. */
  private ensureFlowFast(phone: string) {
    if (this.flowMem.has(phone)) return;
    const seed = emptyFlow();
    if (this.kycTemplateSent.has(phone)) seed.kyc = true;
    this.flowMem.set(phone, seed);
    void this.hydrateFlow(phone);
  }

  /** Graph POST starts now; inbound must not wait for Meta's HTTP ack (was blocking the next reply). */
  private async deliverBotReply(
    settings: WhatsappSettings,
    phone: string,
    reply: ChatMessage,
    waPhoneNumberId: string,
  ) {
    const result = await this.sendWhatsapp(settings, phone, reply, waPhoneNumberId);
    if (result.ok) {
      this.rememberSent(reply.id);
      return;
    }
    reply.sent = false;
    reply.sendError = result.error;
    if (reply.kind === 'kyc_docs') {
      const mem = this.flowMem.get(phone);
      if (mem) mem.kycDocs = false;
    }
    console.error('WhatsappService.deliverBotReply', result.error);
    this.queuePersist(phone, async () => {
      await this.noteSendError(phone, reply.id, result.error || 'WhatsApp send failed');
    });
  }

  private async hydrateFlow(phone: string) {
    const row = await this.readByPhone(phone);
    const messages = row?.chat.messages ?? [];
    const prev = this.flowMem.get(phone) || emptyFlow();
    if (!prev.ids) prev.ids = new Set();
    const offered = alreadyOfferedProduct(messages) || prev.offered;
    const thanked = alreadyThanked(messages) || prev.thanked;
    const kycDocs = alreadyKycDocsAsked(messages) || prev.kycDocs;
    const kyc = alreadyKycStarted(messages) || kycDocs || prev.kyc;
    if (kyc) this.rememberKycPhone(phone);
    if (!prev.product) {
      for (const item of messages) {
        if (item.role === 'assistant' && (item.kind === 'personal_loan' || item.kind === 'insurance')) {
          prev.product = item.kind;
        }
      }
    }
    for (const item of messages) prev.ids.add(item.id);
    prev.welcomed = prev.welcomed || alreadyWelcomed(messages) || offered || thanked;
    prev.offered = offered;
    prev.thanked = thanked;
    prev.kyc = kyc;
    prev.kycDocs = kycDocs;
    this.flowMem.set(phone, prev);
  }

  private decideReply(phone: string, message: InboundWhatsappMessage, assistantId: string): ChatMessage | null {
    const name = message.profileName || '';
    const mem = this.flowMem.get(phone);
    const picked = pickBotReply(message.buttonId, message.text, {
      kyc: Boolean(mem?.kyc || this.kycTemplateSent.has(phone)),
      kycDocs: Boolean(mem?.kycDocs),
      welcomed: Boolean(mem?.welcomed),
      offered: Boolean(mem?.offered),
      thanked: Boolean(mem?.thanked),
      product: mem?.product,
    });
    if (picked.kind === null) return null;
    if (picked.kind === 'kyc_docs') {
      return {
        id: assistantId,
        role: 'assistant',
        text: kycDocsRequestText(),
        at: new Date().toISOString(),
        replyBy: 'template',
        kind: 'kyc_docs',
        waType: 'text',
      };
    }
    if (picked.kind === 'status') {
      return {
        id: assistantId,
        role: 'assistant',
        text: statusCheckText(),
        at: new Date().toISOString(),
        replyBy: 'template',
        kind: 'status',
        waType: 'text',
      };
    }
    if (picked.kind === 'personal_loan' || picked.kind === 'insurance') {
      return this.productTemplateMessage(assistantId, name, picked.kind);
    }
    if (picked.kind === 'thanks') {
      return {
        id: assistantId,
        role: 'assistant',
        text: thankYouText(name),
        at: new Date().toISOString(),
        replyBy: 'template',
        kind: 'thanks',
        waType: 'text',
      };
    }
    return {
      id: assistantId,
      role: 'assistant',
      text: welcomeText(name),
      at: new Date().toISOString(),
      replyBy: 'template',
      kind: 'welcome',
      waType: 'interactive',
    };
  }

  private noteFlow(phone: string, reply: ChatMessage) {
    const prev = this.flowMem.get(phone) || emptyFlow();
    if (!prev.ids) prev.ids = new Set();
    if (reply.kind === 'welcome') prev.welcomed = true;
    if (reply.kind === 'personal_loan' || reply.kind === 'insurance') {
      prev.welcomed = true;
      prev.offered = true;
      prev.product = reply.kind;
    }
    if (reply.kind === 'thanks') prev.thanked = true;
    if (reply.kind === 'kyc') {
      prev.kyc = true;
      this.rememberKycPhone(phone);
    }
    if (reply.kind === 'kyc_docs') {
      prev.kycDocs = true;
      prev.kyc = true;
    }
    prev.ids.add(reply.id);
    this.flowMem.set(phone, prev);
  }

  private rememberIds(phone: string, ids: string[]) {
    const prev = this.flowMem.get(phone) || emptyFlow();
    if (!prev.ids) prev.ids = new Set();
    for (const id of ids) prev.ids.add(id);
    this.flowMem.set(phone, prev);
  }

  private queuePersist(phone: string, fn: () => Promise<void>) {
    const prev = this.persistTail.get(phone) ?? Promise.resolve();
    const next = prev.then(fn).catch((error) => {
      console.error('WhatsappService.persistInbound', error);
    });
    this.persistTail.set(phone, next);
  }

  private waitPersist(phone: string, fn: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      this.queuePersist(phone, async () => {
        try {
          await fn();
        } finally {
          resolve();
        }
      });
    });
  }

  private async persistInbound(
    phone: string,
    profileName: string,
    userMessage: ChatMessage,
    reply: ChatMessage | null,
    waPhoneNumberId: string,
  ) {
    await this.appendMessages(phone, profileName, reply ? [userMessage, reply] : [userMessage], waPhoneNumberId);
  }

  private rememberSent(id: string) {
    this.sentIds.add(id);
    if (this.sentIds.size > 4000) {
      const first = this.sentIds.values().next().value;
      if (first) this.sentIds.delete(first);
    }
  }

  async adminStartChat(rawPhone: string, text: string): Promise<{ ok: boolean; error?: string; data?: WhatsappEnquiryDetail }> {
    const phone = adminTargetPhone(rawPhone);
    if (!phone) return { ok: false, error: 'Enter a valid 10-digit Indian mobile number.' };
    const caption = text.trim().slice(0, 4000);
    if (!caption) return { ok: false, error: 'Type the first message.' };

    const existing = await this.readByPhone(phone);
    if (existing) return this.adminReply(existing.id, caption);

    const settings = await this.settings.getEffective();
    const message: ChatMessage = {
      id: `admin:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      text: caption,
      at: new Date().toISOString(),
      replyBy: 'admin',
      kind: 'admin',
      waType: 'text',
    };
    const result = await this.sendWhatsapp(settings, phone, message, settings.phoneNumberId);
    if (!result.ok) return { ok: false, error: result.error || 'Could not send this message.' };
    message.sent = true;
    const saved = await this.appendMessage(phone, '', message, settings.phoneNumberId);
    if (!saved) return { ok: false, error: 'Sent, but chat could not be saved.' };
    const data = await this.getForAdmin(saved.row.id);
    return data ? { ok: true, data } : { ok: false, error: 'Sent, but chat could not be reloaded.' };
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
      text: caption,
      at: new Date().toISOString(),
      replyBy: 'admin',
      kind: 'admin',
      waType: 'text',
    };
    if (file) {
      if (file.size > MAX_ADMIN_FILE) return { ok: false, error: 'File is too large (max 16 MB).' };
      if (!ADMIN_UPLOAD_MIME.test(file.mimetype)) return { ok: false, error: 'This file type is not allowed.' };
      const uploaded = await this.uploadWhatsappMedia(settings, row.chat.waPhoneNumberId, file);
      if (!uploaded.id) return { ok: false, error: uploaded.error || 'Could not upload this file to WhatsApp.' };
      const waType = graphWaType(file.mimetype);
      message.waType = waType;
      message.mediaId = uploaded.id;
      message.mime = file.mimetype.slice(0, 80);
      if (waType !== 'image') message.filename = file.originalname.slice(0, 180);
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

  private productTemplateMessage(id: string, name: string, choice: ProductChoice): ChatMessage {
    const fileName = productImageFilename(choice);
    return {
      id,
      role: 'assistant',
      text: choice === 'insurance' ? insuranceText(name) : personalLoanText(name),
      at: new Date().toISOString(),
      replyBy: 'template',
      kind: choice,
      waType: 'image',
      filename: fileName,
      mime: 'image/jpeg',
      mediaUrl: productImageUrl(choice),
    };
  }

  private async storeAndSend(
    settings: WhatsappSettings,
    row: EnquiryRow,
    profileName: string,
    message: ChatMessage,
  ) {
    const already = row.chat.messages.some((item) => item.id === message.id);
    if (already) {
      const saved = row.chat.messages.find((item) => item.id === message.id) || message;
      await this.deliver(settings, row.phone, saved);
      return;
    }
    const result = await this.sendWhatsapp(settings, row.phone, message, row.chat.waPhoneNumberId);
    if (result.ok) {
      message.sent = true;
    } else if (result.error) {
      message.sendError = result.error;
    }
    await this.waitPersist(row.phone, async () => {
      await this.appendMessage(row.phone, profileName, message, row.chat.waPhoneNumberId);
    });
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

  private rememberKycPhone(phone: string) {
    this.kycTemplateSent.add(phone);
    if (this.kycTemplateSent.size <= 4000) return;
    const first = this.kycTemplateSent.values().next().value;
    if (first) this.kycTemplateSent.delete(first);
  }

  private async sendKycForVerifiedMobile(ten: string, phone: string): Promise<void> {
    const { data, error } = await this.supabase
      .from(TABLE_LEADS)
      .select('full_name, category')
      .eq('mobile_number', ten)
      .eq('is_active', true)
      .in('category', ['personal_loan', 'insurance'])
      .neq('full_name', LEAD_DRAFT_FULL_NAME)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('WhatsappService.sendKycForVerifiedMobile', error.message);
      return;
    }
    if (!data) return;
    await this.dispatchKycTemplate(phone, String(data.full_name ?? ''), String(data.category ?? ''));
  }

  private async dispatchKycTemplate(phone: string, name: string, category: string): Promise<void> {
    const cat = normalizeStoredCategory(category);
    if (cat !== 'personal_loan' && cat !== 'insurance') return;
    if (!/^[0-9]{8,15}$/.test(phone) || this.kycTemplateSent.has(phone)) return;
    this.rememberKycPhone(phone);

    const settings = this.settings.peekEffective() ?? (await this.settings.getEffective());
    const token = settings.accessToken.trim().replace(/^bearer\s+/i, '').trim();
    const fromId = settings.phoneNumberId.replace(/\D/g, '');
    if (!token || !fromId) {
      this.kycTemplateSent.delete(phone);
      console.error('WhatsappService.dispatchKycTemplate missing WhatsApp settings');
      return;
    }

    const sent = await postGraphMessage(token, fromId, kycGraphPayload(phone, name, cat, KYC_TEMPLATE_LANG));
    if (!sent.ok) {
      this.kycTemplateSent.delete(phone);
      console.error('WhatsappService.dispatchKycTemplate', sent.error);
      return;
    }

    const message: ChatMessage = {
      id: `kyc:${phone}`,
      role: 'assistant',
      text: kycChatText(name, cat),
      at: new Date().toISOString(),
      sent: true,
      replyBy: 'template',
      kind: 'kyc',
      waType: 'text',
    };
    this.noteFlow(phone, message);
    this.queuePersist(phone, async () => {
      await this.appendMessage(phone, name, message);
    });
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
    const needsImage =
      message.waType === 'image' || message.kind === 'personal_loan' || message.kind === 'insurance';
    const outbound = needsImage ? this.withTemplateImage(settings, fromId, message) : message;
    const payload = graphMessageBody(phone, outbound);
    if (!payload) return { ok: false, error: 'Nothing to send.' };
    const sent = await postGraphMessage(token, fromId, payload);
    if (sent.ok || isGraphTimeout(sent.error)) {
      if (outbound.mediaId) message.mediaId = outbound.mediaId;
      if (outbound.waType) message.waType = outbound.waType;
      if (outbound.filename) message.filename = outbound.filename;
      if (outbound.mime) message.mime = outbound.mime;
      return { ok: true };
    }
    return sent;
  }

  private cachedMediaId(fromId: string, fileName: string): string {
    const hit = this.mediaIdCache.get(`${fromId}:${fileName}`);
    return hit && hit.until > Date.now() ? hit.id : '';
  }

  /** Cache hit is instant. A miss sends the public image link and uploads in the background. */
  private withTemplateImage(settings: WhatsappSettings, fromId: string, message: ChatMessage): ChatMessage {
    const fileName = productImageFile(message);
    const cached = fileName && !message.mediaId ? this.cachedMediaId(fromId, fileName) : '';
    if (fileName && !message.mediaId && !cached) void this.templateMediaId(settings, fromId, fileName);
    return withCachedProductImage(message, cached);
  }

  private templateImagePath(fileName: string): string {
    const safe = fileName === 'wa_ins.jpg' ? 'wa_ins.jpg' : 'wa_loa.jpg';
    const bases = [
      join(__dirname, 'media'),
      join(__dirname, '..', 'whatsapp', 'media'),
      join(process.cwd(), 'src', 'whatsapp', 'media'),
      join(process.cwd(), 'dist', 'whatsapp', 'media'),
      join(process.cwd(), 'server', 'src', 'whatsapp', 'media'),
      join(process.cwd(), 'server', 'dist', 'whatsapp', 'media'),
      join(process.cwd(), '..', 'az_web', 'public', 'images', 'whatsapp'),
      join(process.cwd(), 'az_web', 'public', 'images', 'whatsapp'),
      join(process.cwd(), '..', 'az_web', 'public', 'images', 'service'),
      join(process.cwd(), 'az_web', 'public', 'images', 'service'),
    ];
    for (const dir of bases) {
      const jpg = join(dir, safe);
      if (existsSync(jpg)) return jpg;
    }
    return '';
  }

  private warmTemplateMedia(settings: WhatsappSettings) {
    const fromId = settings.phoneNumberId.replace(/\D/g, '');
    if (!fromId || !settings.accessToken) return;
    void this.templateMediaId(settings, fromId, 'wa_loa.jpg');
    void this.templateMediaId(settings, fromId, 'wa_ins.jpg');
  }

  private async templateMediaId(settings: WhatsappSettings, fromId: string, fileName: string): Promise<string> {
    const key = `${fromId}:${fileName}`;
    const hit = this.mediaIdCache.get(key);
    if (hit && hit.until > Date.now()) return hit.id;
    const pending = this.mediaUploadInflight.get(key);
    if (pending) return pending;

    const work = (async () => {
      const path = this.templateImagePath(fileName);
      if (!path) {
        console.error('WhatsappService.templateImagePath missing', fileName);
        return '';
      }
      const uploaded = await this.uploadWhatsappMedia(settings, fromId, {
        buffer: readFileSync(path),
        originalname: fileName,
        mimetype: 'image/jpeg',
      });
      if (!uploaded.id) {
        console.error('WhatsappService.templateMediaId', uploaded.error);
        return '';
      }
      this.mediaIdCache.set(key, { id: uploaded.id, until: Date.now() + 20 * 60 * 60 * 1000 });
      return uploaded.id;
    })();

    this.mediaUploadInflight.set(key, work);
    try {
      return await work;
    } finally {
      this.mediaUploadInflight.delete(key);
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
        signal: AbortSignal.timeout(GRAPH_UPLOAD_MS),
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

  private async appendMessages(
    phone: string,
    profileName: string,
    incoming: ChatMessage[],
    waPhoneNumberId = '',
  ): Promise<{ row: EnquiryRow; added: boolean } | null> {
    const key = canonicalWhatsappPhone(phone);
    if (!/^[0-9]{8,15}$/.test(key) || incoming.length === 0) return null;
    phone = key;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.readByPhone(phone);
      const existing = new Set((current?.chat.messages ?? []).map((item) => item.id));
      const toAdd = incoming.filter((item) => !existing.has(item.id));
      if (toAdd.length === 0) {
        return current ? { row: current, added: false } : null;
      }

      const messages = [...(current?.chat.messages ?? []), ...toAdd].slice(-MAX_MESSAGES);
      const chat: ChatDoc = {
        profileName: profileName.trim() || current?.chat.profileName || '',
        waPhoneNumberId: (waPhoneNumberId || current?.chat.waPhoneNumberId || '').replace(/\D/g, '').slice(0, 30),
        messages,
        ...(current?.chat.leadNote !== undefined ? { leadNote: current.chat.leadNote } : {}),
      };
      const now = new Date().toISOString();
      const lastChatAt = toAdd[toAdd.length - 1]?.at || now;

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
    return null;
  }

  private async appendMessage(
    phone: string,
    profileName: string,
    message: ChatMessage,
    waPhoneNumberId = '',
  ): Promise<{ row: EnquiryRow; added: boolean } | null> {
    return this.appendMessages(phone, profileName, [message], waPhoneNumberId);
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
