/**
 * File storage on DigitalOcean Spaces (S3-compatible). Uploads go through
 * @aws-sdk/lib-storage so large files stream in parts. Degrades gracefully:
 * isStorageConfigured() is false until the DO_SPACES_* env vars are set, and
 * callers should surface STORAGE_NOT_CONFIGURED rather than crash.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

let client: S3Client | null = null;

export function isStorageConfigured(): boolean {
  return !!(
    process.env.DO_SPACES_ENDPOINT &&
    process.env.DO_SPACES_KEY &&
    process.env.DO_SPACES_SECRET &&
    process.env.DO_SPACES_BUCKET
  );
}

function getClient(): S3Client {
  if (client) return client;
  client = new S3Client({
    endpoint: process.env.DO_SPACES_ENDPOINT,
    region: process.env.DO_SPACES_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.DO_SPACES_KEY as string,
      secretAccessKey: process.env.DO_SPACES_SECRET as string,
    },
    forcePathStyle: false,
  });
  return client;
}

const random6 = () => Math.random().toString(36).slice(2, 8);

export interface UploadResult {
  key: string;
  url: string;
  cdnUrl: string;
  size: number;
  contentType: string;
}

/** Upload a buffer under `<folder>/<timestamp>-<random6>-<name>`; returns URLs. */
export async function uploadBuffer(
  folder: string,
  originalName: string,
  buffer: Buffer,
  contentType: string,
): Promise<UploadResult> {
  if (!isStorageConfigured()) throw new Error('STORAGE_NOT_CONFIGURED');

  const bucket = process.env.DO_SPACES_BUCKET as string;
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${folder}/${Date.now()}-${random6()}-${safeName}`;

  await new Upload({
    client: getClient(),
    params: {
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read',
    },
  }).done();

  const endpoint = (process.env.DO_SPACES_ENDPOINT as string).replace(/\/$/, '');
  const cdnBase = process.env.DO_SPACES_CDN_ENDPOINT?.replace(/\/$/, '');
  const url = `${endpoint}/${bucket}/${key}`;
  const cdnUrl = cdnBase ? `${cdnBase}/${key}` : url;

  return { key, url, cdnUrl, size: buffer.length, contentType };
}

/**
 * Read an object back out of Spaces. The diligence pack assembles real evidence
 * files, so the ITC desk needs the read side of storage, not just the write.
 * Returns null when the key is missing so a pack can report a gap rather than
 * fail entirely — an incomplete evidence file is a finding, not a crash.
 */
export async function downloadBuffer(key: string): Promise<Buffer | null> {
  if (!isStorageConfigured()) throw new Error('STORAGE_NOT_CONFIGURED');
  try {
    const res = await getClient().send(
      new GetObjectCommand({ Bucket: process.env.DO_SPACES_BUCKET as string, Key: key }),
    );
    const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) return null;
    return Buffer.from(await body.transformToByteArray());
  } catch {
    return null;
  }
}
