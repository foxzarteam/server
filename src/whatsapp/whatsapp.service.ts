import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_LEADS, TABLE_WP_ENQUIRIES } from '../common/constants';
import { LEAD_DRAFT_FULL_NAME } from '../leads/lead-draft';
import { isDraftLead } from '../leads/lead-present';
import { kycEmploymentBucket } from '../leads/personal-loan-employment';
import { isVehicleLoanCategory } from '../leads/loan-rules';
import { normalizeStoredCategory } from '../leads/lead-present';
import { SUPABASE_CLIENT } from '../config/supabase';
import { isGreeting, pickBotReply } from './whatsapp-bot-rules';
import { allowRateLimitedAction } from '../security/rate-limit';
import {
  adminCustomerName,
  asChat,
  dropFalseMissingFileNotices,
  emptyFlow,
  MAX_MESSAGES,
  unreadCustomerCount,
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
  fetchNamedTemplates,
  metaErrorText,
  plainWhatsappSendError,
  postGraphMessage,
} from './whatsapp-graph';
import {
  buildAdminTemplateSend,
  adminBubbleText,
  findAdminWaTemplate,
  resolveAdminTemplate,
  isTemplateLanguageMiss,
  normalizeMetaTemplates,
  pickApprovedTemplate,
  templateLanguageOrder,
  templatePersonName,
  type MetaTemplateDefinition,
} from './whatsapp-admin-templates';
import {
  adminTargetPhone,
  canonicalWhatsappPhone,
  extractDeliveryUpdates,
  extractInboundMessages,
  InboundWhatsappMessage,
  shouldApplyDelivery,
  WhatsappDeliveryUpdate,
} from './whatsapp-inbound';
import { kycChatText, kycGraphPayload, KYC_START_BTN, KYC_STATUS_BTN, KYC_TEMPLATE_LANG } from './whatsapp-kyc';
import { WhatsappSettings, WhatsappSettingsService } from './whatsapp-settings.service';
import { whatsappSignatureOk } from './whatsapp-verify';
import {
  alreadyKycDocsAsked,
  alreadyKycStarted,
  alreadyOfferedProduct,
  alreadyStatusSent,
  alreadyThanked,
  alreadyWelcomed,
  templateSettled,
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
  rejectedText,
  underReviewText,
  welcomeText,
  type ProductChoice,
} from './whatsapp-templates';

export type { WhatsappEnquiryDetail, WhatsappEnquiryListItem } from './whatsapp-chat';

const MAX_ADMIN_FILE = 16 * 1024 * 1024;
/** Customer files WhatsApp delivers (documents can be up to 100 MB). */
const MAX_CUSTOMER_FILE = 100 * 1024 * 1024;
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
  private kycLeadSent = new Set<string>();
  private underReviewSent = new Set<string>();
  private rejectedSent = new Set<string>();
  /** Check Status already claimed for this phone, so a second tap does not wait or send again. */
  private statusFlight = new Set<string>();
  private inboundTail = new Map<string, Promise<void>>();
  /** One welcome, loan, or insurance send in flight per number. */
  private marketingFlight = new Set<string>();
  private adminTemplateCache = new Map<string, { until: number; template: MetaTemplateDefinition }>();

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

  /** Fire-and-forget after OTP. One KYC template per lead that just got verified. */
  notifyAfterOtpVerified(
    mobile: string,
    leads: { id?: string; full_name?: string; category?: string; ins_type?: string | null }[] = [],
  ): void {
    for (const lead of leads) {
      this.notifyApplicationKycStart({
        leadId: String(lead.id ?? ''),
        phone: mobile,
        name: String(lead.full_name ?? ''),
        category: String(lead.category ?? ''),
        insType: lead.ins_type,
      });
    }
  }

  notifyApplicationKycStart(input: {
    leadId?: string;
    phone: string;
    name: string;
    category?: string;
    insType?: string | null;
  }): void {
    const category = normalizeStoredCategory(String(input.category ?? ''));
    void this.dispatchKycTemplate(
      canonicalWhatsappPhone(input.phone),
      String(input.name ?? ''),
      category,
      String(input.leadId ?? ''),
      input.insType,
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
    const failed = extractDeliveryUpdates(payload);
    if (failed.length) {
      void this.applyDeliveryUpdates(failed).catch((error) => {
        console.error('WhatsappService.applyDeliveryUpdates', error);
      });
    }
    return 'ok';
  }

  /** A message Meta accepted can still fail on the phone. Show that on the same bubble. */
  private async applyDeliveryUpdates(updates: WhatsappDeliveryUpdate[]): Promise<void> {
    for (const update of updates) {
      const phone = canonicalWhatsappPhone(update.phone);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        let applied = false;
        await this.waitPersist(phone, async () => {
          const current = await this.readByPhone(phone);
          const target = current?.chat.messages.find((item) => item.waMessageId === update.waMessageId);
          if (!target) return;
          applied = true;
          if (!shouldApplyDelivery(target.delivery, update.status)) return;
          await this.noteDelivery(phone, target.id, update.status, update.error);
        });
        if (applied) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
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

  async listForAdmin(
    page = 1,
    q = '',
  ): Promise<{ rows: WhatsappEnquiryListItem[]; total: number; page: number; pageSize: number }> {
    const pageSize = 100;
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const from = (safePage - 1) * pageSize;
    const raw = String(q ?? '').trim().slice(0, 40);
    const name = raw.replace(/[%_*,.()"'\\]/g, '').trim();
    const digits = raw.replace(/\D/g, '');
    const filters: string[] = [];
    if (digits.length >= 3) filters.push(`phone.ilike."*${digits}*"`);
    if (/[a-z]/i.test(name)) filters.push(`chat->>profileName.ilike."*${name}*"`);
    if (/[a-z]/i.test(name)) {
      const leadPhones = await this.phonesForLeadName(name);
      for (const phone of leadPhones) filters.push(`phone.eq.${phone}`);
    }

    let query = this.table.select('id, phone, chat, last_chat_at, created_at', { count: 'exact' });
    if (filters.length) query = query.or(filters.join(','));
    const { data, error, count } = await query
      .order('last_chat_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('WhatsappService.listForAdmin', error.message);
      return { rows: [], total: 0, page: safePage, pageSize };
    }

    const rows = (data as EnquiryRow[]) ?? [];
    const applicationNames = await this.applicationNames(rows.map((row) => row.phone));
    return {
      total: count ?? rows.length,
      page: safePage,
      pageSize,
      rows: rows.map((row) => {
      const chat = asChat(row.chat);
      const last = chat.messages[chat.messages.length - 1];
      return {
        id: row.id,
        phone: row.phone,
        profileName: adminCustomerName(chat.profileName, applicationNames.get(row.phone) || ''),
        lastMessage:
          (last ? adminBubbleText(last.id, last.text).trim() : '') ||
          (last?.waType === 'image' ? 'Photo' : last?.filename || (last?.waType === 'document' ? 'File' : last?.waType) || ''),
        lastChatAt: row.last_chat_at,
        createdAt: row.created_at,
        unreadCount: unreadCustomerCount(chat),
      };
    }),
    };
  }

  /** Application names are shown in the sidebar, so search must find those phones too. */
  private async phonesForLeadName(name: string): Promise<string[]> {
    const { data, error } = await this.supabase
      .from(TABLE_LEADS)
      .select('mobile_number')
      .ilike('full_name', `%${name}%`)
      .eq('is_active', true)
      .limit(20);
    if (error || !data) return [];
    return [
      ...new Set(
        data
          .map((row) => canonicalWhatsappPhone(String((row as { mobile_number?: string }).mobile_number ?? '')))
          .filter((phone) => /^[0-9]{8,15}$/.test(phone)),
      ),
    ];
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
    const applicationNames = await this.applicationNames([row.phone]);
    void this.markAdminRead(row.id);
    return {
      id: row.id,
      phone: row.phone,
      profileName: adminCustomerName(chat.profileName, applicationNames.get(row.phone) || ''),
      lastChatAt: row.last_chat_at,
      createdAt: row.created_at,
      messages: chat.messages.map((item) => ({
        id: item.id,
        role: item.role,
        text: adminBubbleText(item.id, item.text),
        at: item.at,
        ...(item.sendError ? { sendError: item.sendError } : {}),
        ...(item.sent ? { sent: true } : {}),
        ...(item.delivery ? { delivery: item.delivery } : {}),
        ...(item.replyBy ? { replyBy: item.replyBy } : {}),
        ...(item.kind ? { kind: item.kind } : {}),
        ...(item.waType ? { waType: item.waType } : {}),
        ...(item.filename ? { filename: item.filename } : {}),
        ...(item.mime ? { mime: item.mime } : {}),
        ...this.bubbleButtons(item),
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
        signal: AbortSignal.timeout(60_000),
      });
      if (!bin.ok) return null;
      const buffer = Buffer.from(await bin.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_CUSTOMER_FILE) return null;
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
    if (textLike) return '';
    if (message.filename) return message.filename;
    if (message.waType === 'image') return 'Photo';
    if (message.waType === 'video') return 'Video';
    if (message.waType === 'audio') return 'Audio';
    if (message.waType === 'document') return 'File';
    return 'File';
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

  private enqueueInbound(phone: string, fn: () => Promise<void>) {
    const prev = this.inboundTail.get(phone) ?? Promise.resolve();
    const next = prev.then(fn).catch((error) => {
      console.error('WhatsappService.handleInbound', error);
    });
    this.inboundTail.set(phone, next);
  }

  private handleInbound(settings: WhatsappSettings, message: InboundWhatsappMessage) {
    const assistantId = `ai:${message.messageId}`;
    if (this.sentIds.has(assistantId) || this.inflight.has(message.messageId)) return;
    this.inflight.add(message.messageId);
    const phone = canonicalWhatsappPhone(message.phone);
    const run = async () => {
      try {
        await this.prepareInbound(settings, message, phone, assistantId);
      } finally {
        this.inflight.delete(message.messageId);
      }
    };
    this.enqueueInbound(phone, run);
  }

  private async prepareInbound(
    settings: WhatsappSettings,
    message: InboundWhatsappMessage,
    phone: string,
    assistantId: string,
  ) {
    const kycClick = isKycStartClick(message.buttonId, message.text);
    const statusClick = isKycStatusClick(message.buttonId, message.text);
    if (kycClick || statusClick) this.seedKycFlow(phone);
    else this.ensureFlowFast(phone);
    const known = this.flowMem.get(phone);
    const statusAlready = statusClick && (Boolean(known?.statusSent) || this.statusFlight.has(phone));
    if (statusClick && !statusAlready) this.statusFlight.add(phone);
    if (!(statusClick && known?.loaded)) {
      await this.hydrateFlow(phone);
    }

    const seen = this.flowMem.get(phone)?.ids;
    const userMessage = this.inboundUserMessage(message);
    if (!seen?.has(message.messageId)) {
      let stored = false;
      await this.waitPersist(phone, async () => {
        stored = await this.persistInbound(phone, message.profileName, userMessage, null, message.phoneNumberId);
      });
      if (stored) this.rememberIds(phone, [userMessage.id]);
    }
    if (seen?.has(assistantId) || this.sentIds.has(assistantId)) {
      if (statusClick && !statusAlready) this.statusFlight.delete(phone);
      return;
    }

    const choice = productChoice(message.buttonId, message.text);
    let reply = this.decideReply(phone, message, assistantId);
    if (statusAlready && reply?.kind === 'status') reply = null;
    if (reply?.kind === 'kyc_docs') {
      const profile = await Promise.race([
        this.kycProfileForPhone(phone),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_500)),
      ]);
      reply = {
        ...reply,
        text: profile
          ? kycDocsRequestText(profile.employment, profile.category)
          : kycDocsRequestText(),
      };
    }
    if (reply && (reply.kind === 'welcome' || reply.kind === 'personal_loan' || reply.kind === 'insurance')) {
      const claim = `${phone}:${reply.kind}`;
      if (this.marketingFlight.has(claim) || (await this.recentlyApplied(phone))) {
        reply = null;
      } else {
        this.marketingFlight.add(claim);
      }
    }
    if (
      reply &&
      reply.kind !== 'welcome' &&
      reply.kind !== 'personal_loan' &&
      reply.kind !== 'insurance' &&
      reply.kind !== 'kyc' &&
      reply.kind !== 'kyc_docs' &&
      reply.kind !== 'status' &&
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

    if (reply) {
      try {
        await this.deliverBotReply(settings, phone, reply, message.phoneNumberId);
      } catch (error) {
        reply.sent = false;
        reply.sendError = error instanceof Error ? error.message : 'WhatsApp send failed';
        this.releaseFailedReply(phone, reply);
        console.error('WhatsappService.deliverBotReply', reply.sendError);
      }
      if (reply.sent) {
        this.noteFlow(phone, reply);
        if (reply.kind === 'welcome' || reply.kind === 'personal_loan' || reply.kind === 'insurance') {
          this.marketingFlight.delete(`${phone}:${reply.kind}`);
        }
      }
    }

    if (reply) this.rememberIds(phone, [reply.id]);
    await this.waitPersist(phone, async () => {
      await this.persistInbound(phone, message.profileName, userMessage, reply, message.phoneNumberId);
    });
  }

  /** KYC Start / Status check: no DB wait. Does not count as Namaste welcome. */
  private seedKycFlow(phone: string) {
    const seed = this.flowMem.get(phone) || emptyFlow();
    if (!seed.ids) seed.ids = new Set();
    seed.kyc = true;
    this.flowMem.set(phone, seed);
  }

  /** Seed memory before history is read. History decides if welcome or a product offer already went out. */
  private ensureFlowFast(phone: string) {
    if (this.flowMem.has(phone)) return;
    const seed = emptyFlow();
    if (this.kycTemplateSent.has(phone)) seed.kyc = true;
    this.flowMem.set(phone, seed);
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
      reply.sent = true;
      delete reply.sendError;
      this.rememberSent(reply.id);
      return;
    }
    reply.sent = false;
    reply.delivery = 'failed';
    reply.sendError = result.error || 'WhatsApp send failed';
    this.releaseFailedReply(phone, reply);
    console.error('WhatsappService.deliverBotReply', result.error);
  }

  /** A failed send can be tried once more. A successful one is never sent again. */
  private releaseFailedReply(phone: string, reply: ChatMessage) {
    const mem = this.flowMem.get(phone);
    if (!mem) return;
    if (reply.kind === 'kyc_docs') mem.kycDocs = false;
    if (reply.kind === 'welcome') mem.welcomed = false;
    if (reply.kind === 'status') {
      mem.statusSent = false;
      this.statusFlight.delete(phone);
    }
    if (reply.kind === 'welcome' || reply.kind === 'personal_loan' || reply.kind === 'insurance') {
      this.marketingFlight.delete(`${phone}:${reply.kind}`);
    }
    if (reply.kind === 'personal_loan') {
      mem.loanOffered = false;
      if (mem.product === 'personal_loan') mem.product = undefined;
    }
    if (reply.kind === 'insurance') {
      mem.insuranceOffered = false;
      if (mem.product === 'insurance') mem.product = undefined;
    }
    mem.offered = Boolean(mem.loanOffered || mem.insuranceOffered);
  }

  private async hydrateFlow(phone: string) {
    const row = await this.readByPhone(phone);
    const messages = row?.chat.messages ?? [];
    const prev = this.flowMem.get(phone) || emptyFlow();
    if (!prev.ids) prev.ids = new Set();
    const offered = alreadyOfferedProduct(messages) || prev.offered;
    const thanked = alreadyThanked(messages) || prev.thanked;
    const kycDocs = alreadyKycDocsAsked(messages) || prev.kycDocs;
    const kyc = alreadyKycStarted(messages) || kycDocs || prev.kyc || this.kycTemplateSent.has(phone);
    const loanOffered = prev.loanOffered || templateSettled(messages, 'personal_loan');
    const insuranceOffered = prev.insuranceOffered || templateSettled(messages, 'insurance');
    if (kyc) this.rememberKycPhone(phone);
    if (!prev.product) {
      for (const item of messages) {
        if (item.sendError) continue;
        if (item.role === 'assistant' && (item.kind === 'personal_loan' || item.kind === 'insurance')) {
          prev.product = item.kind;
        }
      }
    }
    for (const item of messages) prev.ids.add(item.id);
    prev.welcomed = prev.welcomed || alreadyWelcomed(messages) || offered || thanked;
    prev.offered = offered;
    prev.loanOffered = loanOffered;
    prev.insuranceOffered = insuranceOffered;
    prev.thanked = thanked;
    prev.kyc = kyc;
    prev.kycDocs = kycDocs;
    prev.statusSent = prev.statusSent || alreadyStatusSent(messages);
    prev.loaded = true;
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
      loanOffered: Boolean(mem?.loanOffered),
      insuranceOffered: Boolean(mem?.insuranceOffered),
      thanked: Boolean(mem?.thanked),
      statusSent: Boolean(mem?.statusSent),
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
      if (reply.kind === 'personal_loan') prev.loanOffered = true;
      if (reply.kind === 'insurance') prev.insuranceOffered = true;
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
    if (reply.kind === 'status') prev.statusSent = true;
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
    const incoming = reply ? [userMessage, reply] : [userMessage];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const saved = await this.appendMessages(phone, profileName, incoming, waPhoneNumberId);
      if (saved) return true;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
    console.error('WhatsappService.persistInbound failed', phone, incoming.map((item) => item.id).join(','));
    return false;
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
    const sent = await this.storeAndSend(settings, row, row.chat.profileName, message);
    const data = await this.getForAdmin(row.id);
    if (!sent.ok) return { ok: false, error: sent.error || 'Could not send this message.', ...(data ? { data } : {}) };
    return data ? { ok: true, data } : { ok: false, error: 'Sent, but chat could not be reloaded.' };
  }

  /** New number from the compose popup. The typed name is what {{1}} receives. */
  async adminStartTemplate(
    rawPhone: string,
    rawName: string,
    templateId: string,
  ): Promise<{ ok: boolean; error?: string; data?: WhatsappEnquiryDetail }> {
    const phone = adminTargetPhone(rawPhone);
    if (!phone) return { ok: false, error: 'Enter a valid 10-digit Indian mobile number.' };
    const option = findAdminWaTemplate(templateId);
    if (!option) return { ok: false, error: 'Choose a template from the list.' };
    const existing = await this.readByPhone(phone);
    const who = templatePersonName(rawName, '') || (await this.templateCustomerName(phone, existing?.chat.profileName || ''));
    if (!who) return { ok: false, error: 'Enter the customer name. It is filled into the template.' };
    return this.deliverAdminTemplate(option, phone, who, existing?.chat.profileName || who, existing?.chat.waPhoneNumberId || '');
  }

  /** Admin menu templates. Not once-per-phone: the admin chooses when to send again. */
  async adminSendTemplate(
    id: string,
    templateId: string,
    rawName: string,
  ): Promise<{ ok: boolean; error?: string; data?: WhatsappEnquiryDetail }> {
    const option = findAdminWaTemplate(templateId);
    if (!option) return { ok: false, error: 'Choose a template from the list.' };
    const row = await this.getRowById(id);
    if (!row) return { ok: false, error: 'Chat not found.' };
    const who = templatePersonName(rawName, '');
    if (!who) return { ok: false, error: 'Enter the customer name.' };
    return this.deliverAdminTemplate(option, row.phone, who, row.chat.profileName, row.chat.waPhoneNumberId);
  }

  private async deliverAdminTemplate(
    option: NonNullable<ReturnType<typeof findAdminWaTemplate>>,
    phone: string,
    who: string,
    profileName: string,
    waPhoneNumberId: string,
  ): Promise<{ ok: boolean; error?: string; data?: WhatsappEnquiryDetail }> {
    const settings = await this.settings.getEffective();
    const token = settings.accessToken.trim().replace(/^bearer\s+/i, '').trim();
    const configured = settings.phoneNumberId.replace(/\D/g, '');
    const chatFrom = String(waPhoneNumberId || '').replace(/\D/g, '');
    const fromId = chatFrom.length >= 15 ? chatFrom : configured;
    const to = canonicalWhatsappPhone(phone);
    if (!token || !fromId) {
      return {
        ok: false,
        error: !token
          ? 'WhatsApp access token is missing in Settings.'
          : 'WhatsApp phone number ID is missing in Settings.',
      };
    }
    if (!/^[1-9][0-9]{7,14}$/.test(to)) {
      return { ok: false, error: 'This chat does not have a valid WhatsApp number.' };
    }
    const template = await this.approvedAdminTemplate(token, settings.businessAccountId, option.metaName, fromId);
    const languages = templateLanguageOrder(option.metaName, template.language);
    let built: { text: string; buttons: string[] } | null = null;
    let sent: { ok: boolean; error?: string; messageId?: string } = { ok: false, error: 'Could not send this template.' };
    for (const language of languages) {
      const attempt = buildAdminTemplateSend(to, { ...template, language }, who);
      if ('error' in attempt) return { ok: false, error: attempt.error };
      sent = await postGraphMessage(token, fromId, attempt.payload);
      built = attempt;
      if (sent.ok || !isTemplateLanguageMiss(sent.error)) break;
    }
    if (!built) return { ok: false, error: sent.error || 'Could not send this template.' };

    const message: ChatMessage = {
      id: `tpl:${option.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      text: built.text,
      at: new Date().toISOString(),
      replyBy: 'template',
      kind: option.kyc ? 'kyc' : 'admin',
      waType: 'text',
      ...(built.buttons.length ? { buttons: built.buttons } : {}),
    };
    if (sent.ok) {
      message.sent = true;
      message.delivery = 'sent';
      if (sent.messageId) message.waMessageId = sent.messageId;
      if (option.kyc) this.noteFlow(to, message);
    } else {
      message.delivery = 'failed';
      message.sendError = plainWhatsappSendError(sent.error);
    }
    await this.waitPersist(to, async () => {
      await this.appendMessage(to, profileName, message, waPhoneNumberId || settings.phoneNumberId);
    });
    const saved = await this.readByPhone(to);
    const data = saved ? await this.getForAdmin(saved.id) : null;
    if (!sent.ok) return { ok: false, error: message.sendError || 'Could not send this template.', ...(data ? { data } : {}) };
    return data ? { ok: true, data } : { ok: false, error: 'Sent, but chat could not be reloaded.' };
  }

  private bubbleButtons(item: ChatMessage): { buttons: string[] } | Record<string, never> {
    if (item.buttons?.length) return { buttons: item.buttons };
    if (item.kind === 'kyc' && item.id.startsWith('kyc:')) return { buttons: [KYC_START_BTN, KYC_STATUS_BTN] };
    if (item.kind === 'welcome') return { buttons: ['Loan', 'Insurance'] };
    return {};
  }

  private async approvedAdminTemplate(
    token: string,
    businessAccountId: string,
    metaName: string,
    phoneNumberId: string,
  ): Promise<MetaTemplateDefinition> {
    const cached = this.adminTemplateCache.get(metaName);
    if (cached && cached.until > Date.now()) return cached.template;
    const listed = await fetchNamedTemplates(token, businessAccountId, metaName, phoneNumberId);
    const fetched = listed.ok ? pickApprovedTemplate(normalizeMetaTemplates(listed.rows), metaName) : null;
    const template = resolveAdminTemplate(metaName, fetched);
    const savedBody = template.components?.find((item) => String(item.type ?? '').toUpperCase() === 'BODY')?.text ?? '';
    if (savedBody.includes('\n') || savedBody.length > 80) {
      this.adminTemplateCache.set(metaName, { until: Date.now() + 10 * 60 * 1000, template });
    }
    return template;
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
  ): Promise<{ ok: boolean; error?: string }> {
    const already = row.chat.messages.some((item) => item.id === message.id);
    if (already) {
      const saved = row.chat.messages.find((item) => item.id === message.id) || message;
      await this.deliver(settings, row.phone, saved);
      return saved.sendError ? { ok: false, error: saved.sendError } : { ok: true };
    }
    const result = await this.sendWhatsapp(settings, row.phone, message, row.chat.waPhoneNumberId);
    if (result.ok) {
      message.sent = true;
    } else if (result.error) {
      message.sendError = result.error;
      message.delivery = 'failed';
    }
    await this.waitPersist(row.phone, async () => {
      await this.appendMessage(row.phone, profileName, message, row.chat.waPhoneNumberId);
    });
    return result.ok ? { ok: true } : { ok: false, error: message.sendError || result.error };
  }

  /** Only one worker sends a given reply. A stale claim can be taken again after a crash. */
  private async deliver(settings: WhatsappSettings, phone: string, message: ChatMessage) {
    const claimed = await this.claimSend(phone, message.id);
    if (!claimed) return;
    const row = await this.readByPhone(phone);
    const result = await this.sendWhatsapp(settings, phone, message, row?.chat.waPhoneNumberId || '');
    if (result.ok) await this.markSent(phone, message.id, message);
    else {
      await this.releaseSend(phone, message.id);
      if (result.error) await this.noteSendError(phone, message.id, result.error);
    }
  }

  /** Form name for this number, including spaced or +91 mobiles. WhatsApp profile name only if no real application exists. */
  private async templateCustomerName(phone: string, profileName: string): Promise<string> {
    const rows = await this.leadRowsForPhone(phone, 'full_name, pan, mobile_number, updated_at');
    const application = (rows ?? []).find((row) => !isDraftLead(row));
    return templatePersonName(String(application?.full_name ?? ''), profileName);
  }

  /** Latest non-draft application name for each chat phone. Keyed by the enquiry phone. */
  private async applicationNames(phones: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(phones.map((phone) => phone.trim()).filter(Boolean))];
    if (!unique.length) return out;
    const numbers = [...new Set(unique.flatMap((phone) => this.phoneLookupKeys(phone)))];
    if (!numbers.length) return out;
    const byNumber = new Map<string, string>();
    for (let i = 0; i < numbers.length; i += 100) {
      const chunk = numbers.slice(i, i + 100);
      const { data, error } = await this.supabase
        .from(TABLE_LEADS)
        .select('mobile_number, full_name, pan, updated_at')
        .in('mobile_number', chunk)
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(500);
      if (error) {
        console.error('WhatsappService.applicationNames', error.message);
        continue;
      }
      for (const row of data ?? []) {
        const record = row as Record<string, unknown>;
        if (isDraftLead(record)) continue;
        const mobile = String(record.mobile_number ?? '').trim();
        const name = String(record.full_name ?? '').trim();
        if (!mobile || !name || byNumber.has(mobile)) continue;
        byNumber.set(mobile, name);
      }
    }
    for (const phone of unique) {
      const name = this.phoneLookupKeys(phone)
        .map((key) => byNumber.get(key))
        .find((value) => value);
      if (name) out.set(phone, name);
    }
    return out;
  }

  private phoneLookupKeys(phone: string): string[] {
    const canonical = canonicalWhatsappPhone(phone);
    const ten = canonical.startsWith('91') && canonical.length === 12 ? canonical.slice(2) : canonical;
    const keys = [canonical, ten];
    if (ten.length === 10) keys.push(`+91${ten}`, `+${canonical}`);
    return [...new Set(keys.filter((value) => value.length >= 10))];
  }

  /** Leads lookup whenever a welcome, loan, or insurance reply is about to go out. */
  private async recentlyApplied(phone: string): Promise<boolean> {
    const mem = this.flowMem.get(phone);
    if (this.kycTemplateSent.has(phone) || mem?.kyc) return true;
    const history = mem?.ids;
    if (history && [...history].some((id) => id.startsWith('kyc:'))) return true;
    const applied = await Promise.race([
      this.applicationOnPhone(phone),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
    if (applied === true) {
      this.rememberKycPhone(phone);
      if (mem) {
        mem.kyc = true;
        mem.welcomed = true;
      }
      return true;
    }
    return false;
  }

  /** True when a real lead exists, false when this number is fresh, null when the lookup failed. */
  private async applicationOnPhone(phone: string): Promise<boolean | null> {
    const rows = await this.leadRowsForPhone(phone, 'full_name, pan, mobile_number');
    if (!rows) return null;
    return rows.some((row) => !isDraftLead(row));
  }

  /** Same person even if the saved mobile is 10 digits, 91..., or has spaces. Null means the lookup failed. */
  private async leadRowsForPhone(phone: string, columns: string): Promise<Record<string, unknown>[] | null> {
    const canonical = canonicalWhatsappPhone(phone);
    const ten = canonical.startsWith('91') && canonical.length === 12 ? canonical.slice(2) : '';
    if (!/^[6-9]\d{9}$/.test(ten)) return [];
    const filters = [
      `mobile_number.eq."${ten}"`,
      `mobile_number.eq."91${ten}"`,
      `mobile_number.eq."+91${ten}"`,
      `mobile_number.ilike."*${ten}"`,
      `mobile_number.ilike."*${ten.slice(0, 5)}*${ten.slice(5)}*"`,
    ];
    const { data, error } = await this.supabase
      .from(TABLE_LEADS)
      .select(columns)
      .eq('is_active', true)
      .or(filters.join(','))
      .order('updated_at', { ascending: false })
      .limit(20);
    if (error) {
      console.error('WhatsappService.leadRowsForPhone', error.message);
      return null;
    }
    return ((data ?? []) as unknown as Record<string, unknown>[]).filter(
      (row) => canonicalWhatsappPhone(String(row.mobile_number ?? '')) === canonical,
    );
  }

  /** Latest real application, so the KYC document list matches that product. */
  private async kycProfileForPhone(phone: string): Promise<{
    employment: 'salaried' | 'self_employed' | null;
    category: string | null;
  }> {
    const empty = { employment: null as 'salaried' | 'self_employed' | null, category: null as string | null };
    const data = await this.leadRowsForPhone(
      phone,
      'full_name, pan, mobile_number, employment_type, category, updated_at',
    );
    if (!data) return empty;
    let category: string | null = null;
    for (const record of data) {
      if (isDraftLead(record)) continue;
      const leadCategory = String(record.category ?? '').trim().toLowerCase();
      if (!category) category = leadCategory;
      if (isVehicleLoanCategory(leadCategory) && category === leadCategory) {
        return { employment: null, category: leadCategory };
      }
      const bucket = kycEmploymentBucket(String(record.employment_type ?? ''));
      if (bucket) return { employment: bucket, category };
    }
    return { employment: null, category };
  }

  /** One Under Review note per phone, even if the admin flips that status again. */
  notifyUnderReview(mobile: string, name: string): void {
    void this.sendUnderReviewOnce(mobile, name).catch((error) => {
      console.error('WhatsappService.notifyUnderReview', error);
    });
  }

  private async sendUnderReviewOnce(mobile: string, name: string, attempt = 0): Promise<void> {
    const phone = canonicalWhatsappPhone(mobile);
    if (!/^[0-9]{8,15}$/.test(phone)) return;
    if (this.underReviewSent.has(phone)) return;
    this.underReviewSent.add(phone);

    const existing = await this.readByPhone(phone);
    const already = existing?.chat.messages.some((item) => item.kind === 'under_review' && !item.sendError);
    if (already) return;

    const settings = this.settings.peekEffective() ?? (await this.settings.getEffective());
    const message: ChatMessage = {
      id: `review:${phone}`,
      role: 'assistant',
      text: underReviewText(),
      at: new Date().toISOString(),
      replyBy: 'template',
      kind: 'under_review',
      waType: 'text',
    };
    const sent = await this.sendWhatsapp(settings, phone, message, existing?.chat.waPhoneNumberId || '');
    if (!sent.ok) {
      this.underReviewSent.delete(phone);
      message.sent = false;
      message.sendError = sent.error || 'WhatsApp send failed';
      console.error('WhatsappService.sendUnderReviewOnce', message.sendError);
      if (attempt < 1) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        return this.sendUnderReviewOnce(mobile, name, attempt + 1);
      }
      return;
    }
    message.sent = true;
    await this.waitPersist(phone, async () => {
      await this.appendMessage(phone, name, message, existing?.chat.waPhoneNumberId || '');
    });
  }

  /** One not-approved note per phone, even if the admin sets that status again. */
  notifyRejected(mobile: string, name: string): void {
    void this.sendRejectedOnce(mobile, name).catch((error) => {
      console.error('WhatsappService.notifyRejected', error);
    });
  }

  private async sendRejectedOnce(mobile: string, name: string, attempt = 0): Promise<void> {
    const phone = canonicalWhatsappPhone(mobile);
    if (!/^[0-9]{8,15}$/.test(phone)) return;
    if (this.rejectedSent.has(phone)) return;
    this.rejectedSent.add(phone);

    const existing = await this.readByPhone(phone);
    const already = existing?.chat.messages.some((item) => item.kind === 'rejected' && !item.sendError);
    if (already) return;

    const settings = this.settings.peekEffective() ?? (await this.settings.getEffective());
    const message: ChatMessage = {
      id: `reject:${phone}`,
      role: 'assistant',
      text: rejectedText(),
      at: new Date().toISOString(),
      replyBy: 'template',
      kind: 'rejected',
      waType: 'text',
    };
    const sent = await this.sendWhatsapp(settings, phone, message, existing?.chat.waPhoneNumberId || '');
    if (!sent.ok) {
      this.rejectedSent.delete(phone);
      message.sent = false;
      message.sendError = sent.error || 'WhatsApp send failed';
      console.error('WhatsappService.sendRejectedOnce', message.sendError);
      if (attempt < 1) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        return this.sendRejectedOnce(mobile, name, attempt + 1);
      }
      return;
    }
    message.sent = true;
    await this.waitPersist(phone, async () => {
      await this.appendMessage(phone, name, message, existing?.chat.waPhoneNumberId || '');
    });
  }

  private rememberKycPhone(phone: string) {
    this.kycTemplateSent.add(phone);
    if (this.kycTemplateSent.size <= 4000) return;
    const first = this.kycTemplateSent.values().next().value;
    if (first) this.kycTemplateSent.delete(first);
  }

  private async dispatchKycTemplate(
    phone: string,
    name: string,
    category: string,
    leadId = '',
    insType?: string | null,
    attempt = 0,
  ): Promise<void> {
    const cat = normalizeStoredCategory(category);
    const who = name.trim();
    if (!who || who.toLowerCase() === LEAD_DRAFT_FULL_NAME.toLowerCase()) return;
    if (!/^[0-9]{8,15}$/.test(phone)) return;
    const leadKey = leadId.trim() || `${phone}:${cat}:${String(insType ?? '')}`;
    if (this.kycLeadSent.has(leadKey)) return;
    this.kycLeadSent.add(leadKey);
    if (this.kycLeadSent.size > 4000) {
      const first = this.kycLeadSent.values().next().value;
      if (first) this.kycLeadSent.delete(first);
    }

    const settings = this.settings.peekEffective() ?? (await this.settings.getEffective());
    const token = settings.accessToken.trim().replace(/^bearer\s+/i, '').trim();
    const fromId = settings.phoneNumberId.replace(/\D/g, '');
    if (!token || !fromId) {
      this.kycLeadSent.delete(leadKey);
      console.error('WhatsappService.dispatchKycTemplate missing WhatsApp settings');
      return;
    }

    const existing = await this.readByPhone(phone);
    if (existing?.chat.messages.some((item) => item.id === `kyc:${leadKey}` && !item.sendError)) {
      this.rememberKycPhone(phone);
      return;
    }

    const sent = await postGraphMessage(
      token,
      fromId,
      kycGraphPayload(phone, who, cat, KYC_TEMPLATE_LANG, insType),
    );
    if (!sent.ok) {
      this.kycLeadSent.delete(leadKey);
      console.error('WhatsappService.dispatchKycTemplate', sent.error);
      if (attempt < 1) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        return this.dispatchKycTemplate(phone, name, category, leadId, insType, attempt + 1);
      }
      return;
    }
    this.rememberKycPhone(phone);

    const message: ChatMessage = {
      id: `kyc:${leadKey}`,
      role: 'assistant',
      text: kycChatText(who, cat, insType),
      at: new Date().toISOString(),
      sent: true,
      delivery: 'sent',
      ...(sent.messageId ? { waMessageId: sent.messageId } : {}),
      replyBy: 'template',
      kind: 'kyc',
      waType: 'text',
    };
    this.noteFlow(phone, message);
    await this.waitPersist(phone, async () => {
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
    const configured = settings.phoneNumberId.replace(/\D/g, '');
    const chatFrom = String(waPhoneNumberId || '').replace(/\D/g, '');
    const fromId = chatFrom.length >= 15 ? chatFrom : configured;
    const to = canonicalWhatsappPhone(phone);
    if (!token || !fromId) {
      const error = !token
        ? 'WhatsApp access token is missing in Settings.'
        : 'WhatsApp phone number ID is missing in Settings.';
      console.error('WhatsappService.sendWhatsapp', error);
      return { ok: false, error };
    }
    if (!/^[1-9][0-9]{7,14}$/.test(to)) {
      return { ok: false, error: 'This chat does not have a valid WhatsApp number.' };
    }
    const needsImage =
      message.waType === 'image' || message.kind === 'personal_loan' || message.kind === 'insurance';
    const outbound = needsImage ? this.withTemplateImage(settings, fromId, message) : message;
    const payload = graphMessageBody(to, outbound);
    if (!payload) return { ok: false, error: 'Nothing to send.' };
    const sent = await postGraphMessage(token, fromId, payload);
    if (sent.ok) {
      message.delivery = 'sent';
      if (sent.messageId) message.waMessageId = sent.messageId;
      if (outbound.mediaId) message.mediaId = outbound.mediaId;
      if (outbound.waType) message.waType = outbound.waType;
      if (outbound.filename) message.filename = outbound.filename;
      if (outbound.mime) message.mime = outbound.mime;
      return { ok: true };
    }
    if (message.kind === 'personal_loan' || message.kind === 'insurance') {
      const textPayload = graphMessageBody(to, { ...message, waType: 'text' });
      if (textPayload) {
        const textSent = await postGraphMessage(token, fromId, textPayload);
        if (textSent.ok) {
          message.delivery = 'sent';
          if (textSent.messageId) message.waMessageId = textSent.messageId;
          message.waType = 'text';
          delete message.mediaId;
          delete message.mediaUrl;
          delete message.filename;
          delete message.mime;
          return { ok: true };
        }
      }
    }
    message.delivery = 'failed';
    message.sendError = plainWhatsappSendError(sent.error);
    return { ok: false, error: message.sendError };
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

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await this.readByPhone(phone);
      const existing = new Set((current?.chat.messages ?? []).map((item) => item.id));
      const toAdd = incoming.filter((item) => !existing.has(item.id));
      if (toAdd.length === 0) {
        return current ? { row: current, added: false } : null;
      }

      const prior = current?.chat.messages ?? [];
      const messages = dropFalseMissingFileNotices([...prior, ...toAdd]).slice(-MAX_MESSAGES);
      if (
        current &&
        messages.length === prior.length &&
        messages.every((item, index) => item.id === prior[index]?.id)
      ) {
        return { row: current, added: false };
      }
      let adminReadAt = current?.chat.adminReadAt;
      if (!adminReadAt && toAdd.some((item) => item.role === 'user')) {
        adminReadAt = prior[prior.length - 1]?.at || '1970-01-01T00:00:00.000Z';
      }
      const chat: ChatDoc = {
        profileName: profileName.trim() || current?.chat.profileName || '',
        waPhoneNumberId: (waPhoneNumberId || current?.chat.waPhoneNumberId || '').replace(/\D/g, '').slice(0, 30),
        messages,
        ...(current?.chat.leadNote !== undefined ? { leadNote: current.chat.leadNote } : {}),
        ...(adminReadAt ? { adminReadAt } : {}),
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

  /** Opening a chat marks customer messages seen. Retries so a new message is not overwritten. */
  private async markAdminRead(id: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.table
        .select('id, phone, chat, last_chat_at, created_at, updated_at')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return;
      const row = data as EnquiryRow;
      const chat = asChat(row.chat);
      if (chat.adminReadAt && unreadCustomerCount(chat) === 0) return;
      const next: ChatDoc = { ...chat, adminReadAt: new Date().toISOString() };
      const saved = await this.table
        .update({ chat: next, updated_at: next.adminReadAt })
        .eq('id', id)
        .eq('updated_at', row.updated_at)
        .select('id')
        .maybeSingle();
      if (!saved.error && saved.data) return;
    }
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
    for (let attempt = 0; attempt < 6; attempt += 1) {
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

  private markSent(phone: string, messageId: string, stamp?: ChatMessage) {
    return this.patchMessage(
      phone,
      messageId,
      (message) => {
        const next = {
          ...message,
          sent: true,
          delivery: stamp?.delivery || message.delivery || 'sent',
          ...(stamp?.waMessageId ? { waMessageId: stamp.waMessageId } : {}),
        };
        delete next.sending;
        delete next.sendingAt;
        delete next.sendError;
        return next;
      },
      (message) => !message.sent || !message.waMessageId,
    );
  }

  private noteDelivery(
    phone: string,
    messageId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    error?: string,
  ) {
    const sendError = status === 'failed' ? plainWhatsappSendError(error).slice(0, 500) : '';
    return this.patchMessage(
      phone,
      messageId,
      (message) => {
        if (status === 'failed') {
          const next = { ...message, delivery: status, sendError, sent: false };
          delete next.sending;
          delete next.sendingAt;
          return next;
        }
        const next = { ...message, delivery: status, sent: true };
        delete next.sendError;
        delete next.sending;
        delete next.sendingAt;
        return next;
      },
      (message) => shouldApplyDelivery(message.delivery, status),
    );
  }

  private noteSendError(phone: string, messageId: string, error: string) {
    const sendError = error.slice(0, 500);
    return this.patchMessage(
      phone,
      messageId,
      (message) => {
        const next = { ...message, sendError, sent: false, delivery: 'failed' as const };
        delete next.sending;
        delete next.sendingAt;
        return next;
      },
      (message) => message.sent !== false || message.sendError !== sendError,
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
