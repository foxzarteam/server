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

/** Admin-facing reason. Meta accepts a test number and rejects everyone else while the app is not Live. */
export function plainWhatsappSendError(error?: string): string {
  const text = String(error ?? '').trim();
  if (/131030|not in allowed list|allowed list/i.test(text)) {
    return 'WhatsApp is still in test mode, so only numbers added in Meta can receive messages. Switch the app to Live, or add this customer as a test number.';
  }
  if (/131047|re-engagement|more than 24 hours|24 hours/i.test(text)) {
    return 'This customer has not messaged in the last 24 hours, so WhatsApp blocked the reply. Ask them to send a new message, then reply again.';
  }
  if (/131026|undeliverable|not a whatsapp/i.test(text)) {
    return 'WhatsApp could not deliver this message. Check that the number is on WhatsApp.';
  }
  return (text || 'WhatsApp send failed').slice(0, 500);
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
): Promise<{ ok: boolean; error?: string; status?: number; messageId?: string }> {
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
    let messageId = '';
    try {
      const data = (await res.json()) as { messages?: { id?: string }[] };
      messageId = String(data.messages?.[0]?.id ?? '').trim().slice(0, 200);
    } catch {
      messageId = '';
    }
    return { ok: true, ...(messageId ? { messageId } : {}) };
  } catch (error) {
    const fail = error instanceof Error ? error.message : 'WhatsApp send failed';
    return { ok: false, error: fail.slice(0, 300) };
  }
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

async function graphJson(
  token: string,
  url: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GRAPH_SEND_MS),
    });
    if (!res.ok) return { ok: false, error: await metaErrorText(res) };
    const body = (await res.json()) as Record<string, unknown>;
    return { ok: true, body };
  } catch (error) {
    const fail = error instanceof Error ? error.message : 'Could not load this WhatsApp template.';
    return { ok: false, error: fail.slice(0, 300) };
  }
}

function templateListUrl(wabaId: string, name?: string): string {
  const base =
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(wabaId)}/message_templates` +
    '?fields=name,status,language,components&limit=100';
  return name ? `${base}&name=${encodeURIComponent(name)}` : base;
}

async function readTemplatePages(token: string, firstUrl: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  let url = firstUrl;
  for (let page = 0; page < 5 && url; page += 1) {
    let listed = await graphJson(token, url);
    if (!listed.ok && url.includes('fields=')) {
      listed = await graphJson(token, url.replace(/([?&])fields=[^&]+&?/, '$1').replace(/[?&]$/, ''));
    }
    if (!listed.ok) break;
    if (Array.isArray(listed.body.data)) rows.push(...listed.body.data);
    const paging = listed.body.paging;
    const next = paging && typeof paging === 'object' ? String((paging as { next?: unknown }).next ?? '') : '';
    if (!next || url.includes('name=')) break;
    url = next;
  }
  return rows;
}

/** The token itself knows the WhatsApp account id, even when Settings has the Business Manager id. */
async function wabaIdsFromToken(token: string): Promise<string[]> {
  const listed = await graphJson(
    token,
    `https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(token)}`,
  );
  if (!listed.ok) return [];
  const data = listed.body.data;
  if (!data || typeof data !== 'object') return [];
  const scopes = (data as { granular_scopes?: { scope?: string; target_ids?: unknown[] }[] }).granular_scopes;
  const ids: string[] = [];
  for (const scope of scopes ?? []) {
    if (!/whatsapp_business/i.test(String(scope.scope ?? ''))) continue;
    for (const raw of scope.target_ids ?? []) {
      const id = digitsOnly(String(raw ?? ''));
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** Business Manager id and the WhatsApp account id are different. Templates live on the WhatsApp account. */
async function candidateWabaIds(token: string, businessAccountId: string, phoneNumberId: string): Promise<string[]> {
  const ids: string[] = [];
  const add = (value: unknown) => {
    const id = digitsOnly(String(value ?? ''));
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const id of await wabaIdsFromToken(token)) add(id);
  add(businessAccountId);
  const phoneId = digitsOnly(phoneNumberId);
  if (phoneId) {
    const phone = await graphJson(
      token,
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneId)}?fields=whatsapp_business_account`,
    );
    if (phone.ok) {
      const account = phone.body.whatsapp_business_account;
      if (account && typeof account === 'object') add((account as { id?: unknown }).id);
    }
  }
  const businessId = digitsOnly(businessAccountId);
  if (businessId) {
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      const listed = await graphJson(
        token,
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(businessId)}/${edge}?fields=id&limit=20`,
      );
      if (!listed.ok || !Array.isArray(listed.body.data)) continue;
      for (const row of listed.body.data) {
        if (row && typeof row === 'object') add((row as { id?: unknown }).id);
      }
    }
  }
  return ids;
}

export async function fetchNamedTemplates(
  token: string,
  businessAccountId: string,
  name: string,
  phoneNumberId = '',
): Promise<{ ok: true; rows: unknown[] } | { ok: false; error: string }> {
  const templateName = name.trim();
  if (!templateName) return { ok: false, error: 'Choose a template from the list.' };
  const ids = await candidateWabaIds(token, businessAccountId, phoneNumberId);
  if (!ids.length) return { ok: false, error: 'WhatsApp business account ID is missing in Settings.' };
  const rows: unknown[] = [];
  const matches = () =>
    rows.some((row) => String((row as { name?: unknown })?.name ?? '').trim().toLowerCase() === templateName.toLowerCase());
  for (const id of ids) {
    rows.push(...(await readTemplatePages(token, templateListUrl(id, templateName))));
    if (matches()) return { ok: true, rows };
  }
  for (const id of ids) {
    rows.push(...(await readTemplatePages(token, templateListUrl(id))));
    if (matches()) break;
  }
  return { ok: true, rows };
}

export async function postGraphMessage(
  token: string,
  fromId: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  let sent = await postGraphOnce(token, fromId, payload);
  for (let attempt = 0; !sent.ok && attempt < GRAPH_RETRY_MS.length; attempt += 1) {
    if (!isRetryableGraphError(sent.error, sent.status)) break;
    await new Promise((resolve) => setTimeout(resolve, GRAPH_RETRY_MS[attempt]));
    sent = await postGraphOnce(token, fromId, payload);
  }
  if (!sent.ok) console.error('WhatsappService.sendWhatsapp', sent.error);
  return { ok: sent.ok, error: sent.error, ...(sent.messageId ? { messageId: sent.messageId } : {}) };
}
