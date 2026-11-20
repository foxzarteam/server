import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_WP_ENQUIRIES } from '../common/constants';
import {
  asChat,
  dropFalseMissingFileNotices,
  placeKycBeforeClicks,
  MAX_MESSAGES,
  type ChatDoc,
  type ChatMessage,
  type EnquiryRow,
} from './whatsapp-chat';
import { canonicalWhatsappPhone, phoneLookupKeys } from './whatsapp-inbound';

const ENQUIRY_COLS = 'id, phone, chat, last_chat_at, created_at, updated_at';

export class WhatsappEnquiryStore {
  constructor(private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_WP_ENQUIRIES);
  }

  async readByPhone(phone: string, extraKeys: string[] = []): Promise<EnquiryRow | null> {
    const alts = [
      ...new Set(
        [...phoneLookupKeys(phone), ...extraKeys.map((key) => canonicalWhatsappPhone(key))].filter(
          (value) => value.length >= 8,
        ),
      ),
    ];
    if (!alts.length) return null;
    const { data, error } = await this.table
      .select(ENQUIRY_COLS)
      .in('phone', alts)
      .order('last_chat_at', { ascending: false, nullsFirst: false })
      .limit(1);
    if (error) {
      console.error('WhatsappEnquiryStore.readByPhone', error.message);
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as EnquiryRow | undefined;
    if (!row) return null;
    return { ...row, chat: asChat(row.chat) };
  }

  async appendMessages(
    phone: string,
    profileName: string,
    incoming: ChatMessage[],
    waPhoneNumberId = '',
  ): Promise<{ row: EnquiryRow; added: boolean } | null> {
    const key = canonicalWhatsappPhone(phone);
    if (!/^[0-9]{8,24}$/.test(key) || incoming.length === 0) return null;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await this.readByPhone(key);
      const existing = new Set((current?.chat.messages ?? []).map((item) => item.id));
      const toAdd = incoming.filter((item) => !existing.has(item.id));
      if (toAdd.length === 0) {
        return current ? { row: current, added: false } : null;
      }

      const prior = current?.chat.messages ?? [];
      const messages = placeKycBeforeClicks(dropFalseMissingFileNotices([...prior, ...toAdd])).slice(-MAX_MESSAGES);
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
      const lastChatAt = messages[messages.length - 1]?.at || now;

      if (!current) {
        const { data, error } = await this.table
          .insert({
            phone: key,
            chat,
            last_chat_at: lastChatAt,
            updated_at: now,
          })
          .select(ENQUIRY_COLS)
          .maybeSingle();
        if (!error && data) {
          const row = data as EnquiryRow;
          return { row: { ...row, chat: asChat(row.chat) }, added: true };
        }
        if (error?.code === '23505') continue;
        console.error('WhatsappEnquiryStore.append.insert', error?.message);
        return null;
      }

      const { data, error } = await this.table
        .update({ chat, last_chat_at: lastChatAt, updated_at: now })
        .eq('id', current.id)
        .eq('updated_at', current.updated_at)
        .select(ENQUIRY_COLS)
        .maybeSingle();

      if (!error && data) {
        const row = data as EnquiryRow;
        return { row: { ...row, chat: asChat(row.chat) }, added: true };
      }
      if (error) console.error('WhatsappEnquiryStore.append.update', error.message);
    }
    return null;
  }

  /** Customer quoted an admin bubble: attach the inbound to that chat even if Meta sent a LID. */
  async findByWaMessageId(waMessageId: string): Promise<EnquiryRow | null> {
    const id = String(waMessageId ?? '').trim().slice(0, 200);
    if (id.length < 8 || !/^[\w.+=/-]+$/.test(id)) return null;
    const { data, error } = await this.table
      .select(ENQUIRY_COLS)
      .filter('chat->messages', 'cs', JSON.stringify([{ waMessageId: id }]))
      .order('last_chat_at', { ascending: false, nullsFirst: false })
      .limit(1);
    if (error) {
      console.error('WhatsappEnquiryStore.findByWaMessageId', error.message);
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as EnquiryRow | undefined;
    if (!row) return null;
    return { ...row, chat: asChat(row.chat) };
  }
}
