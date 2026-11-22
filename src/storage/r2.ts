import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

process.env.AWS_REQUEST_CHECKSUM_CALCULATION ??= 'WHEN_REQUIRED';
process.env.AWS_RESPONSE_CHECKSUM_VALIDATION ??= 'WHEN_REQUIRED';

type R2Settings = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

let client: S3Client | null = null;

export function r2Settings(): R2Settings | null {
  const endpoint = process.env.R2_ENDPOINT?.trim() ?? '';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() ?? '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() ?? '';
  const bucket = process.env.R2_BUCKET?.trim() ?? '';
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
      forcePathStyle: true,
      // AWS SDK v3 default CRC32 checksums fail on R2 PutObject.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
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
      (key) => !(process.env[key] ?? '').trim(),
    );
    return { ok: false, error: `R2 not configured: missing ${missing.join(', ') || 'R2 settings'}` };
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

export function r2PublicBaseUrl(): string {
  return (process.env.R2_PUBLIC_BASE_URL?.trim() ?? '').replace(/\/+$/, '');
}
