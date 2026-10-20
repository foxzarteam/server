import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

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
