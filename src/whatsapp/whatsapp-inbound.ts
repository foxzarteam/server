export type InboundWhatsappMessage = {
  phone: string;
  messageId: string;
  text: string;
  buttonId: string;
  profileName: string;
  type: string;
  /** Meta phone number id that received this message. */
  phoneNumberId: string;
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
  if (!mime && !filename && !sha) return null;
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
  let phone = digits(raw).replace(/^0+/, '');
  if (phone.length === 10 && /^[6-9]/.test(phone)) phone = `91${phone}`;
  return phone;
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
        const phone = canonicalWhatsappPhone(String(msg.from ?? ''));
        const messageId = String(msg.id ?? '').trim();
        if (!/^[0-9]{8,15}$/.test(phone) || !messageId || messageId.length > 200) continue;

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
          const reply = asRecord(interactive?.button_reply) || asRecord(interactive?.list_reply);
          text = String(reply?.title ?? '').trim();
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
          }
        }

        // Edits and deletes are not a customer file. Do not show a blank bubble.
        if (!text && !mediaId && (unsupportedKind === 'edit' || unsupportedKind === 'revoke' || type === 'system' || type === 'reaction')) {
          continue;
        }
        if (!text && !mediaId && (type === 'unsupported' || type === 'unknown')) {
          text = 'This file did not come through. Ask the customer to send it again as a photo or PDF.';
        }

        const contact = contacts
          .map(asRecord)
          .find((row) => row && canonicalWhatsappPhone(String(row.wa_id ?? '')) === phone);
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
