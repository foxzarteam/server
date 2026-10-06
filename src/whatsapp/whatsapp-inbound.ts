export type InboundWhatsappMessage = {
  phone: string;
  messageId: string;
  text: string;
  buttonId: string;
  profileName: string;
  type: string;
  /** Meta phone number id that received this message. */
  phoneNumberId: string;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function digits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

/** Same person, one key: 9876543210 and 919876543210 both become 919876543210. */
export function canonicalWhatsappPhone(raw: string): string {
  let phone = digits(raw).replace(/^0+/, '');
  if (phone.length === 10 && /^[6-9]/.test(phone)) phone = `91${phone}`;
  return phone;
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

        const type = String(msg.type ?? 'unknown').slice(0, 40);
        let text = '';
        let buttonId = '';
        if (type === 'text') text = String(asRecord(msg.text)?.body ?? '').trim();
        else if (type === 'button') {
          text = String(asRecord(msg.button)?.text ?? '').trim();
          buttonId = String(asRecord(msg.button)?.payload ?? '').trim();
        } else if (type === 'interactive') {
          const interactive = asRecord(msg.interactive);
          const reply = asRecord(interactive?.button_reply) || asRecord(interactive?.list_reply);
          text = String(reply?.title ?? '').trim();
          buttonId = String(reply?.id ?? '').trim();
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
        });
      }
    }
  }

  return out;
}
