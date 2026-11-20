export type InboundWhatsappMessage = {
  phone: string;
  messageId: string;
  text: string;
  buttonId: string;
  profileName: string;
  type: string;
  /** Meta phone number id that received this message. */
  phoneNumberId: string;
  /** Quoted admin bubble (wamid) — used when Meta sends a LID instead of the mobile. */
  contextId?: string;
  fromUserId?: string;
  aliases?: string[];
  waType?: 'image' | 'document' | 'audio' | 'video';
  mediaId?: string;
  mime?: string;
  filename?: string;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function digits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

const MEDIA_FIELDS = ['image', 'sticker', 'video', 'audio', 'voice', 'ptt', 'document'] as const;

function waTypeFor(field: string, mime: string): NonNullable<InboundWhatsappMessage['waType']> {
  const kind = mime.toLowerCase();
  if (kind.startsWith('image/')) return 'image';
  if (kind.startsWith('video/')) return 'video';
  if (kind.startsWith('audio/')) return 'audio';
  if (field === 'video') return 'video';
  if (field === 'audio' || field === 'voice' || field === 'ptt') return 'audio';
  if (field === 'image' || field === 'sticker') return 'image';
  return 'document';
}

function mediaFromRecord(
  media: UnknownRecord,
  field: string,
): { mediaId: string; mime: string; filename: string; text: string; waType: NonNullable<InboundWhatsappMessage['waType']> } | null {
  const id = String(media.id ?? '').trim();
  if (!id || id.length > 200 || id.startsWith('wamid')) return null;
  const mime = String(media.mime_type ?? '').trim().slice(0, 80);
  const filename = String(media.filename ?? '').trim().slice(0, 180);
  const sha = String(media.sha256 ?? '').trim();
  const knownMedia = (MEDIA_FIELDS as readonly string[]).includes(field);
  if (!mime && !filename && !sha && !knownMedia) return null;
  return {
    mediaId: id,
    mime,
    filename,
    text: String(media.caption ?? '').trim(),
    waType: waTypeFor(field, mime),
  };
}

/** Finds a file even when WhatsApp puts it under an unexpected key. */
function findNestedMedia(value: unknown, depth = 0): ReturnType<typeof mediaFromRecord> {
  if (depth > 4 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedMedia(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as UnknownRecord;
  for (const [key, child] of Object.entries(record)) {
    if (key === 'context' || key === 'errors' || key === 'contacts' || key === 'referral') continue;
    const media = asRecord(child);
    if (!media) continue;
    const direct = mediaFromRecord(media, key);
    if (direct) return direct;
    const nested = findNestedMedia(media, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Any file object on the webhook, even when WhatsApp labels the message unsupported. */
function inboundMedia(
  msg: UnknownRecord,
  type: string,
): { mediaId: string; mime: string; filename: string; text: string; waType: NonNullable<InboundWhatsappMessage['waType']> } | null {
  const preferred =
    type === 'voice' || type === 'ptt'
      ? ['voice', 'audio', 'ptt']
      : type === 'sticker'
        ? ['sticker', 'image']
        : [type];
  const seen = new Set<string>();
  for (const key of [...preferred, ...MEDIA_FIELDS]) {
    if (seen.has(key)) continue;
    seen.add(key);
    const media = asRecord(msg[key]);
    if (!media) continue;
    const direct = mediaFromRecord(media, key);
    if (direct) return direct;
  }
  return findNestedMedia(msg);
}

function locationText(msg: UnknownRecord): string {
  const loc = asRecord(msg.location);
  if (!loc) return '';
  const lat = Number(loc.latitude);
  const lng = Number(loc.longitude);
  const name = String(loc.name ?? loc.address ?? '').trim();
  const link = Number.isFinite(lat) && Number.isFinite(lng) ? `https://maps.google.com/?q=${lat},${lng}` : '';
  return [name, link].filter(Boolean).join('\n');
}

function contactsText(msg: UnknownRecord): string {
  const rows = Array.isArray(msg.contacts) ? msg.contacts : [];
  const lines = rows
    .map((row) => {
      const contact = asRecord(row);
      if (!contact) return '';
      const name = String(asRecord(contact.name)?.formatted_name ?? '').trim();
      const phones = Array.isArray(contact.phones) ? contact.phones : [];
      const phone = phones
        .map((item) => String(asRecord(item)?.phone ?? '').trim())
        .filter(Boolean)
        .join(', ');
      return [name, phone].filter(Boolean).join(' · ');
    })
    .filter(Boolean);
  return lines.join('\n');
}

/** Same person, one key: 9876543210 and 919876543210 both become 919876543210. */
export function canonicalWhatsappPhone(raw: string): string {
  let phone = digits(String(raw ?? '').replace(/@lid$/i, '')).replace(/^0+/, '');
  if (phone.length === 10 && /^[6-9]/.test(phone)) phone = `91${phone}`;
  return phone;
}

/** Real mobile we can send to. LIDs are usually 15+ digits. */
export function looksLikeWhatsappMsisdn(phone: string): boolean {
  const key = canonicalWhatsappPhone(phone);
  if (/^91[6-9]\d{9}$/.test(key)) return true;
  return key.length >= 8 && key.length <= 13;
}

export function looksLikeWhatsappLid(raw: string, digitsOnly = ''): boolean {
  if (/lid/i.test(raw)) return true;
  const key = digitsOnly || canonicalWhatsappPhone(raw);
  return key.length >= 15;
}

/** DB rows may be 10-digit, 91…, or +91… — look up all of them. */
export function phoneLookupKeys(phone: string): string[] {
  const key = canonicalWhatsappPhone(phone);
  const ten = key.startsWith('91') && key.length === 12 ? key.slice(2) : '';
  return [...new Set([key, ten, ten ? `+91${ten}` : ''].filter((value) => value.length >= 10))];
}

function inboundIdentity(msg: UnknownRecord, contacts: unknown[]): {
  phone: string;
  fromUserId: string;
  aliases: string[];
} {
  const fromRaw = String(msg.from ?? '');
  const fromPhone = canonicalWhatsappPhone(fromRaw);
  const fromUserId = digits(msg.from_user_id ?? '');
  const contactWa = contacts
    .map((row) => canonicalWhatsappPhone(String(asRecord(row)?.wa_id ?? '')))
    .filter((value) => value.length >= 8);
  const contactUsers = contacts.map((row) => digits(asRecord(row)?.user_id ?? '')).filter((value) => value.length >= 8);
  const candidates = [...new Set([fromPhone, ...contactWa].filter(Boolean))];
  const msisdn = candidates.find((value) => looksLikeWhatsappMsisdn(value)) || '';
  const lidFallback =
    candidates.find((value) => looksLikeWhatsappLid(fromRaw, value)) ||
    candidates.find((value) => value.length >= 8) ||
    '';
  const phone = msisdn || lidFallback || fromUserId;
  const aliases = [...new Set([...candidates, ...contactUsers, fromUserId].filter((value) => value.length >= 8))];
  return { phone, fromUserId, aliases };
}

/** Admin start-chat: only a real Indian mobile, always stored as 91 + 10 digits. */
export function adminTargetPhone(raw: string): string | null {
  const canonical = canonicalWhatsappPhone(raw);
  const ten = canonical.startsWith('91') && canonical.length === 12 ? canonical.slice(2) : canonical;
  return /^[6-9]\d{9}$/.test(ten) ? `91${ten}` : null;
}

/**
 * Pull customer messages out of a Meta WhatsApp webhook body.
 * Status callbacks and other events return an empty list.
 */
export function extractInboundMessages(body: unknown): InboundWhatsappMessage[] {
  const root = asRecord(body);
  if (!root) return [];
  if (root.object && root.object !== 'whatsapp_business_account') return [];

  const entries = Array.isArray(root.entry) ? root.entry : [];
  const out: InboundWhatsappMessage[] = [];

  for (const entry of entries) {
    const changes = Array.isArray(asRecord(entry)?.changes) ? (asRecord(entry)?.changes as unknown[]) : [];
    for (const change of changes) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];

      for (const raw of messages) {
        const msg = asRecord(raw);
        if (!msg) continue;
        const identity = inboundIdentity(msg, contacts);
        const phone = identity.phone;
        const messageId = String(msg.id ?? '').trim();
        const contextId = String(asRecord(msg.context)?.id ?? '').trim().slice(0, 200);
        if (!messageId || messageId.length > 200) continue;
        if (!phone && !contextId && !identity.fromUserId) continue;

        const type = String(msg.type ?? 'unknown').trim().toLowerCase().slice(0, 40);
        const unsupportedKind = String(asRecord(msg.unsupported)?.type ?? '').trim().toLowerCase();
        let text = '';
        let buttonId = '';
        let waType: InboundWhatsappMessage['waType'];
        let mediaId = '';
        let mime = '';
        let filename = '';
        if (type === 'text') text = String(asRecord(msg.text)?.body ?? '').trim();
        else if (type === 'button') {
          text = String(asRecord(msg.button)?.text ?? '').trim();
          buttonId = String(asRecord(msg.button)?.payload ?? '').trim();
        } else if (type === 'interactive') {
          const interactive = asRecord(msg.interactive);
          const reply =
            asRecord(interactive?.button_reply) ||
            asRecord(interactive?.list_reply) ||
            asRecord(interactive?.nfm_reply);
          text = String(reply?.title ?? reply?.name ?? reply?.body ?? '').trim();
          buttonId = String(reply?.id ?? '').trim();
        } else if (type === 'location') {
          text = locationText(msg);
        } else if (type === 'contacts') {
          text = contactsText(msg);
        } else if (type === 'reaction') {
          const emoji = String(asRecord(msg.reaction)?.emoji ?? '').trim();
          text = emoji ? `Reacted ${emoji}` : '';
        } else {
          const pulled = inboundMedia(msg, type);
          if (pulled) {
            mediaId = pulled.mediaId;
            mime = pulled.mime;
            filename = pulled.filename;
            text = pulled.text;
            waType = pulled.waType;
          } else {
            text = String(asRecord(msg.text)?.body ?? '').trim();
          }
        }

        // Edits and deletes are not a customer file. Do not show a blank bubble.
        if (!text && !mediaId && (unsupportedKind === 'edit' || unsupportedKind === 'revoke' || type === 'system' || type === 'reaction')) {
          continue;
        }
        if (!text && !mediaId && (type === 'unsupported' || type === 'unknown')) {
          text = 'This file did not come through. Ask the customer to send it again as a photo or PDF.';
        }

        const contactRows = contacts.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row));
        const contact =
          contactRows.find((row) => canonicalWhatsappPhone(String(row.wa_id ?? '')) === phone) ||
          contactRows.find((row) => String(asRecord(row.profile)?.name ?? '').trim());
        const profileName = String(asRecord(contact?.profile)?.name ?? '').trim().slice(0, 120);

        const metadata = asRecord(value.metadata);
        const phoneNumberId = digits(metadata?.phone_number_id).slice(0, 30);

        out.push({
          phone,
          messageId,
          text: text.slice(0, 4000),
          buttonId: buttonId.slice(0, 80),
          profileName,
          type,
          phoneNumberId,
          ...(contextId ? { contextId } : {}),
          ...(identity.fromUserId ? { fromUserId: identity.fromUserId } : {}),
          ...(identity.aliases.length ? { aliases: identity.aliases } : {}),
          ...(waType ? { waType } : {}),
          ...(mediaId ? { mediaId } : {}),
          ...(mime ? { mime } : {}),
          ...(filename ? { filename } : {}),
        });
      }
    }
  }

  return out.filter((item) => {
    if (item.mediaId || !item.text.startsWith('This file did not come through')) return true;
    return !out.some((other) => other.phone === item.phone && other.mediaId);
  });
}

export type WhatsappDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export type WhatsappDeliveryUpdate = {
  phone: string;
  waMessageId: string;
  status: WhatsappDeliveryStatus;
  error?: string;
};

const DELIVERY_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

/** A later receipt can move forward. A failure does not wipe a message that already reached the phone. */
export function shouldApplyDelivery(current: string | undefined, next: string): boolean {
  if (next === 'failed') return current !== 'delivered' && current !== 'read';
  return (DELIVERY_RANK[next] ?? 0) > (DELIVERY_RANK[current ?? ''] ?? 0);
}

/** Meta tells us when a message reached the phone, was read, or failed. */
export function extractDeliveryUpdates(body: unknown): WhatsappDeliveryUpdate[] {
  const root = asRecord(body);
  if (!root) return [];
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const out: WhatsappDeliveryUpdate[] = [];
  for (const entry of entries) {
    const changes = Array.isArray(asRecord(entry)?.changes) ? (asRecord(entry)?.changes as unknown[]) : [];
    for (const change of changes) {
      const value = asRecord(asRecord(change)?.value);
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      for (const raw of statuses) {
        const status = asRecord(raw);
        const kind = String(status?.status ?? '').toLowerCase();
        if (kind !== 'sent' && kind !== 'delivered' && kind !== 'read' && kind !== 'failed') continue;
        const phone = canonicalWhatsappPhone(String(status?.recipient_id ?? ''));
        const waMessageId = String(status?.id ?? '').trim().slice(0, 200);
        if (!/^[0-9]{8,15}$/.test(phone) || waMessageId.length < 8) continue;
        if (kind === 'failed') {
          const errors = Array.isArray(status?.errors) ? status.errors : [];
          const first = asRecord(errors[0]);
          const code = String(first?.code ?? '').trim();
          const message = String(first?.message ?? first?.title ?? '').trim();
          const error = [code, message].filter(Boolean).join(': ') || 'WhatsApp could not deliver this message.';
          out.push({ phone, waMessageId, status: 'failed', error: error.slice(0, 500) });
          continue;
        }
        out.push({ phone, waMessageId, status: kind });
      }
    }
  }
  return out;
}
