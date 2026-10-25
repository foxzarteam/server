import type { ChatMessage } from './whatsapp-chat';
import { welcomeInteractive, welcomeText } from './whatsapp-templates';

export const GRAPH_VERSION = 'v21.0';
export const GRAPH_UPLOAD_MS = 8_000;
/** Wait for a slow Meta response, then try again. */
const GRAPH_SEND_MS = 12_000;
const GRAPH_RETRY_MS = [800, 2_000];

export function isGraphTimeout(error?: string): boolean {
  return /timeout|aborted|abort/i.test(error || '');
}

/** Meta was slow, busy, or the connection dropped. Auth and bad payloads are not retried. */
export function isRetryableGraphError(error?: string, status?: number): boolean {
  if (status === 408 || status === 429 || (status != null && status >= 500)) return true;
  if (status != null && status >= 400 && status < 500) return false;
  return isGraphTimeout(error) || /network|fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(error || '');
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
): Promise<{ ok: boolean; error?: string; status?: number }> {
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
    if (!res.ok) return { ok: false, status: res.status, error: await metaErrorText(res) };
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
  let sent = await postGraphOnce(token, fromId, payload);
  for (let attempt = 0; !sent.ok && attempt < GRAPH_RETRY_MS.length; attempt += 1) {
    if (!isRetryableGraphError(sent.error, sent.status)) break;
    await new Promise((resolve) => setTimeout(resolve, GRAPH_RETRY_MS[attempt]));
    sent = await postGraphOnce(token, fromId, payload);
  }
  if (!sent.ok) console.error('WhatsappService.sendWhatsapp', sent.error);
  return { ok: sent.ok, error: sent.error };
}
