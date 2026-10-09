import type { ChatMessage } from './whatsapp-chat';
import { welcomeInteractive, welcomeText } from './whatsapp-templates';

export const GRAPH_VERSION = 'v21.0';
export const GRAPH_SEND_MS = 8_000;
export const GRAPH_UPLOAD_MS = 8_000;

export function isGraphTimeout(error?: string): boolean {
  return /timeout|aborted|abort/i.test(error || '');
}

export function graphWaType(mime: string): NonNullable<ChatMessage['waType']> {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

export async function metaErrorText(res: Response): Promise<string> {
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

export function graphMessageBody(phone: string, message: ChatMessage): Record<string, unknown> | null {
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
  };
  if (message.waType === 'interactive' || message.kind === 'welcome') {
    return { ...base, ...welcomeInteractive(message.text || welcomeText('')) };
  }
  if (
    message.waType === 'image' ||
    message.waType === 'document' ||
    message.waType === 'audio' ||
    message.waType === 'video'
  ) {
    const kind = message.waType;
    const media: Record<string, string> = {};
    if (message.mediaId) media.id = message.mediaId;
    else if (message.mediaUrl && kind === 'image') media.link = message.mediaUrl;
    if (media.id || media.link) {
      if (message.text && kind !== 'audio') media.caption = message.text.slice(0, 1024);
      if (kind === 'document' && message.filename) media.filename = message.filename;
      return { ...base, type: kind, [kind]: media };
    }
  }
  const body = message.text.replace(/\uFFFD/g, '').trim().slice(0, 4000);
  if (!body) return null;
  return {
    ...base,
    type: 'text',
    text: { preview_url: false, body },
  };
}

async function postGraphOnce(
  token: string,
  fromId: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(fromId)}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GRAPH_SEND_MS),
    });
    if (!res.ok) return { ok: false, error: await metaErrorText(res) };
    return { ok: true };
  } catch (error) {
    const fail = error instanceof Error ? error.message : 'WhatsApp send failed';
    return { ok: false, error: fail.slice(0, 300) };
  }
}

export async function postGraphMessage(
  token: string,
  fromId: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const sent = await postGraphOnce(token, fromId, payload);
  if (!sent.ok) console.error('WhatsappService.sendWhatsapp', sent.error);
  return sent;
}
