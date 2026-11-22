import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

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
    });
  }
  return client;
}

export async function r2PutObject(params: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const settings = r2Settings();
  if (!settings) {
    console.error('r2PutObject missing R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET');
    return { ok: false, error: 'Could not upload this image.' };
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
    console.error('r2PutObject', err instanceof Error ? err.message : err);
    return { ok: false, error: 'Could not upload this image.' };
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
  } catch {
    return { ok: false };
  }
}

export function r2PublicBaseUrl(): string {
  return (process.env.R2_PUBLIC_BASE_URL?.trim() ?? '').replace(/\/+$/, '');
}
