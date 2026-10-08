import type { ProductChoice } from './whatsapp-templates';

export const MAX_MESSAGES = 1000;

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  sent?: boolean;
  sending?: boolean;
  sendingAt?: string;
  sendError?: string;
  replyBy?: 'template' | 'admin';
  kind?: 'welcome' | 'personal_loan' | 'insurance' | 'status' | 'admin' | 'thanks' | 'kyc';
  waType?: 'text' | 'interactive' | 'image' | 'document' | 'audio' | 'video';
  mediaId?: string;
  mediaUrl?: string;
  filename?: string;
  mime?: string;
};

export type ChatDoc = {
  profileName: string;
  waPhoneNumberId: string;
  messages: ChatMessage[];
  leadNote?: string;
};

export type EnquiryRow = {
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
  messages: {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    at: string;
    sendError?: string;
    replyBy?: string;
    kind?: string;
    waType?: string;
    filename?: string;
    mime?: string;
    hasMedia?: boolean;
  }[];
};

export type FlowMem = {
  welcomed: boolean;
  offered: boolean;
  thanked: boolean;
  kyc: boolean;
  product?: ProductChoice;
  ids: Set<string>;
};

export function emptyFlow(): FlowMem {
  return { welcomed: false, offered: false, thanked: false, kyc: false, ids: new Set() };
}

export function asChat(raw: unknown): ChatDoc {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const obj =
    value && typeof value === 'object'
      ? (value as {
          profileName?: unknown;
          messages?: unknown;
          waPhoneNumberId?: unknown;
          leadNote?: unknown;
        })
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
    const replyBy =
      rawBy === 'admin'
        ? 'admin'
        : rawBy === 'template' || rawBy === 'groq' || rawBy === 'gemini'
          ? 'template'
          : undefined;
    const kind =
      row.kind === 'welcome' ||
      row.kind === 'personal_loan' ||
      row.kind === 'insurance' ||
      row.kind === 'status' ||
      row.kind === 'admin' ||
      row.kind === 'thanks' ||
      row.kind === 'kyc'
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
      ...(row.mediaUrl && /^https:\/\//i.test(String(row.mediaUrl))
        ? { mediaUrl: String(row.mediaUrl).slice(0, 500) }
        : {}),
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
