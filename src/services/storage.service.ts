/**
 * File storage on DigitalOcean Spaces (S3-compatible). Uploads go through
 * @aws-sdk/lib-storage so large files stream in parts. Degrades gracefully:
 * isStorageConfigured() is false until the DO_SPACES_* env vars are set, and
 * callers should surface STORAGE_NOT_CONFIGURED rather than crash.
 */
import { S3Client } from '@aws-sdk/client-s3';
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
