export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';

const GROQ_TIMEOUT_MS = 4_500;

type GroqModel = { id?: string };
type GroqContent = string | { text?: string }[] | null;
type GroqReply = { choices?: { message?: { content?: GroqContent } }[] };

export function groqModelScore(id: string): number {
  if (/whisper|orpheus|guard|tts|safeguard/i.test(id)) return -1000;
  let score = 0;
  if (/gpt-oss-20b/i.test(id)) score += 100;
  if (/8b|instant/i.test(id)) score += 50;
  if (/gpt-oss-120b/i.test(id)) score += 40;
  return score;
}

export function defaultGroqModel(available: string[]): string {
  const ranked = [...available]
    .map((id) => id.trim())
    .filter(Boolean)
    .sort((a, b) => groqModelScore(b) - groqModelScore(a) || a.localeCompare(b));
  return ranked[0] || DEFAULT_GROQ_MODEL;
}

function authHeaders(key: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function chatModelId(id: string): string {
  const model = id.trim();
  if (!model || groqModelScore(model) < 0) return '';
  return model;
}

export async function listGroqChatModels(key: string): Promise<string[]> {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: authHeaders(key),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('groq-client.listModels', res.status);
      return [];
    }
    const data = (await res.json()) as { data?: GroqModel[] };
    const ids = (data.data ?? []).map((model) => chatModelId(String(model.id ?? ''))).filter(Boolean);
    return [...new Set(ids)].sort((a, b) => groqModelScore(b) - groqModelScore(a) || a.localeCompare(b));
  } catch (error) {
    console.error('groq-client.listModels', error instanceof Error ? error.message : error);
    return [];
  }
}

function replyText(content: GroqContent | undefined): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : String(part?.text ?? '')))
    .join('')
    .trim();
}

async function errorDetail(res: Response, key: string): Promise<string> {
  let detail = '';
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    detail = String(data.error?.message ?? '');
  } catch {
    detail = '';
  }
  return (detail || `Groq request failed (${res.status})`).replaceAll(key, '***').slice(0, 300);
}

function requestSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!parent) return timeout;
  return AbortSignal.any([timeout, parent]);
}

function modelUnavailable(status: number, detail: string): boolean {
  if (status === 404) return true;
  return /model.*(not found|does not exist|decommissioned)|unknown model|invalid model/i.test(detail);
}

export async function generateGroq(
  key: string,
  model: string,
  system: string,
  contents: { role: 'user' | 'assistant'; text: string }[],
  plain = false,
  signal?: AbortSignal,
): Promise<{ text: string; error?: string; unavailable?: boolean }> {
  const messages = [
    { role: 'system', content: system },
    ...contents.map((turn) => ({ role: turn.role, content: turn.text })),
  ];
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(key, true),
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.4,
        max_tokens: 280,
        ...(!plain && /gpt-oss/i.test(model) ? { reasoning_effort: 'low' } : {}),
      }),
      signal: requestSignal(GROQ_TIMEOUT_MS, signal),
    });
    if (!res.ok) {
      const detail = await errorDetail(res, key);
      if (!plain && /reasoning_effort|unknown parameter|invalid argument/i.test(detail)) {
        return generateGroq(key, model, system, contents, true, signal);
      }
      const error = `${model}: ${detail}`.slice(0, 500);
      console.error('groq-client.generate', error);
      return { text: '', error, unavailable: modelUnavailable(res.status, detail) };
    }
    const data = (await res.json()) as GroqReply;
    const text = replyText(data.choices?.[0]?.message?.content).slice(0, 4000);
    if (text) return { text };
    const error = `${model}: empty reply`.slice(0, 300);
    console.error('groq-client.generate', error);
    return { text: '', error };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return { text: '' };
    }
    const message = error instanceof Error ? error.message : 'Groq request failed';
    const safe = message.replaceAll(key, '***').slice(0, 240);
    console.error('groq-client.generate', model, safe);
    return { text: '', error: `${model}: ${safe}`.slice(0, 300) };
  }
}
