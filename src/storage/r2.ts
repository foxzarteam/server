import './r2-aws-env';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

type R2Settings = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

let client: S3Client | null = null;

function cleanEnv(raw: string | undefined): string {
  let value = String(raw ?? '').trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.replace(/\r|\n/g, '').trim();
}

function normalizeEndpoint(raw: string): string {
  const value = cleanEnv(raw);
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

export function r2Settings(): R2Settings | null {
  const endpoint = normalizeEndpoint(process.env.R2_ENDPOINT ?? '');
  const accessKeyId = cleanEnv(process.env.R2_ACCESS_KEY_ID);
  const secretAccessKey = cleanEnv(process.env.R2_SECRET_ACCESS_KEY);
  const bucket = cleanEnv(process.env.R2_BUCKET);
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { endpoint, accessKeyId, secretAccessKey, bucket };
}

function r2Client(settings: R2Settings): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: settings.endpoint,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
    });
  }
  return client;
}

function r2ErrorText(err: unknown): string {
  if (!err || typeof err !== 'object') return `R2: ${String(err ?? 'upload failed')}`;
  const e = err as {
    name?: string;
    message?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const text = [
    e.name,
    e.Code || e.code,
    e.$metadata?.httpStatusCode != null ? `http ${e.$metadata.httpStatusCode}` : '',
    e.message,
  ]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' | ')
    .replace(/[{}]/g, ' ')
    .slice(0, 500);
  return `R2: ${text || 'upload failed'}`;
}

export async function r2PutObject(params: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const settings = r2Settings();
  if (!settings) {
    const missing = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter(
      (key) => !cleanEnv(process.env[key]),
    );
    return { ok: false, error: `R2 not configured: missing ${missing.join(', ') || 'R2 settings'}` };
  }
  if (settings.secretAccessKey.startsWith('cfat_')) {
    return {
      ok: false,
      error:
        'R2_SECRET_ACCESS_KEY is a Cloudflare API token. Use the S3 Secret Access Key from R2 API tokens.',
    };
  }
  try {
    await r2Client(settings).send(
      new PutObjectCommand({
        Bucket: settings.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
      }),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: r2ErrorText(err) };
  }
}

export async function r2GetObject(
  key: string,
): Promise<{ ok: true; body: Buffer; contentType: string } | { ok: false }> {
  const settings = r2Settings();
  if (!settings) return { ok: false };
  try {
    const out = await r2Client(settings).send(
      new GetObjectCommand({ Bucket: settings.bucket, Key: key }),
    );
    const bytes = await out.Body?.transformToByteArray();
    if (!bytes?.length) return { ok: false };
    return {
      ok: true,
      body: Buffer.from(bytes),
      contentType: out.ContentType || 'application/octet-stream',
    };
  } catch (err) {
    console.error('r2GetObject', err instanceof Error ? err.message : err);
    return { ok: false };
  }
}

export async function r2DeleteObject(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const settings = r2Settings();
  if (!settings) return { ok: false, error: 'R2 not configured' };
  const objectKey = key.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '').trim();
  if (!objectKey || objectKey.includes('..')) return { ok: false, error: 'Invalid R2 key' };
  try {
    await r2Client(settings).send(
      new DeleteObjectCommand({ Bucket: settings.bucket, Key: objectKey }),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: r2ErrorText(err) };
  }
}

/** Delete every object under a prefix, e.g. `kyc/{userId}/`. */
export async function r2DeletePrefix(
  prefix: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const settings = r2Settings();
  if (!settings) return { ok: false, error: 'R2 not configured' };
  if (settings.secretAccessKey.startsWith('cfat_')) {
    return {
      ok: false,
      error:
        'R2_SECRET_ACCESS_KEY is a Cloudflare API token. Use the S3 Secret Access Key from R2 API tokens.',
    };
  }
  const safe = prefix.replace(/^\/+/, '').trim();
  if (!safe.startsWith('kyc/') || !safe.endsWith('/') || safe.includes('..')) {
    return { ok: false, error: 'Invalid KYC prefix' };
  }
  try {
    let token: string | undefined;
    do {
      const listed = await r2Client(settings).send(
        new ListObjectsV2Command({
          Bucket: settings.bucket,
          Prefix: safe,
          ContinuationToken: token,
        }),
      );
      for (const obj of listed.Contents ?? []) {
        const key = String(obj.Key ?? '').trim();
        if (!key.startsWith(safe)) continue;
        const removed = await r2DeleteObject(key);
        if (!removed.ok) return removed;
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: r2ErrorText(err) };
  }
}

export function r2PublicBaseUrl(): string {
  return cleanEnv(process.env.R2_PUBLIC_BASE_URL).replace(/\/+$/, '');
}
