import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

type R2Settings = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

let client: S3Client | null = null;

function r2Settings(): R2Settings | null {
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
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

/** Puts the file in the private R2 bucket and returns the object key. Nothing is written to disk. */
export async function uploadCibilReport(
  leadId: string,
  file: { name: string; mime: string; bytes: Buffer },
): Promise<{ key: string } | { error: string }> {
  const settings = r2Settings();
  if (!settings) return { error: 'CIBIL storage is not configured.' };
  const key = `cibil/${leadId}/${file.name}`;
  try {
    await r2Client(settings).send(
      new PutObjectCommand({
        Bucket: settings.bucket,
        Key: key,
        Body: file.bytes,
        ContentType: file.mime,
      }),
    );
    return { key };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'upload failed';
    console.error('uploadCibilReport', message);
    return { error: message };
  }
}

function reportFileName(key: string): string {
  const raw = key.split('/').pop()?.trim() || 'cibil-report';
  const cleaned = raw.replace(/[\r\n"]/g, '').slice(0, 120);
  return cleaned || 'cibil-report';
}

/** Reads a private CIBIL object. The key must be the path stored on the lead. */
export async function openCibilObject(key: string): Promise<
  { stream: Readable; mime: string; filename: string; size: number | null } | { error: string }
> {
  const safeKey = key.trim();
  if (!/^cibil\/[0-9a-f-]{36}\/[^/]+$/i.test(safeKey) || safeKey.includes('..')) {
    return { error: 'Invalid report.' };
  }
  const settings = r2Settings();
  if (!settings) return { error: 'CIBIL storage is not configured.' };
  try {
    const out = await r2Client(settings).send(
      new GetObjectCommand({
        Bucket: settings.bucket,
        Key: safeKey,
      }),
    );
    const body = out.Body;
    if (!body || typeof (body as Readable).pipe !== 'function') {
      return { error: 'Report file is missing.' };
    }
    const filename = reportFileName(safeKey);
    return {
      stream: body as Readable,
      mime: out.ContentType?.trim() || 'application/octet-stream',
      filename,
      size: typeof out.ContentLength === 'number' ? out.ContentLength : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'download failed';
    console.error('openCibilObject', message);
    return { error: message };
  }
}

export function cibilDownloadDisposition(filename: string): string {
  const safe = filename.replace(/[\r\n"]/g, '').slice(0, 120) || 'cibil-report';
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
