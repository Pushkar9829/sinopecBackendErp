const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const env = require('../config/env');

function safeExt(originalName = '') {
  const ext = path.extname(originalName || '').toLowerCase().slice(0, 12);
  return /^\.[a-z0-9.]+$/.test(ext) ? ext : '';
}

// Content type comes from the (allow-listed) extension, never from the
// client's claimed MIME type, so a file can't be served as something else.
const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
  '.ai': 'application/postscript',
  '.eps': 'application/postscript',
  '.psd': 'image/vnd.adobe.photoshop',
  '.cdr': 'application/octet-stream',
};
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function contentTypeFor(originalName) {
  return CONTENT_TYPES[safeExt(originalName)] || 'application/octet-stream';
}

function buildKey(folder, originalName) {
  const cleanFolder = String(folder || 'misc')
    .replace(/[^a-zA-Z0-9/_-]/g, '')
    .replace(/^\/+|\/+$/g, '') || 'misc';
  return `${cleanFolder}/${Date.now()}-${randomUUID()}${safeExt(originalName)}`;
}

function createS3Client() {
  if (!env.s3.enabled) return null;
  if (!env.s3.accessKeyId) return new S3Client({ region: env.s3.region });
  return new S3Client({
    region: env.s3.region,
    credentials: {
      accessKeyId: env.s3.accessKeyId,
      secretAccessKey: env.s3.secretAccessKey,
    },
  });
}

function publicUrlForKey(key) {
  if (env.s3.publicBaseUrl) {
    return `${env.s3.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
  return `https://${env.s3.bucket}.s3.${env.s3.region}.amazonaws.com/${key}`;
}

async function uploadBuffer({ buffer, originalName, mimeType, folder = 'misc' }) {
  if (!buffer || !buffer.length) {
    throw new Error('Empty file');
  }

  const key = buildKey(folder, originalName);
  const contentType = contentTypeFor(originalName);

  if (env.s3.enabled) {
    const client = createS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: env.s3.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ...(INLINE_TYPES.has(contentType) ? {} : { ContentDisposition: 'attachment' }),
      })
    );
    return {
      key,
      url: publicUrlForKey(key),
      originalName: originalName || path.basename(key),
      mimeType: contentType,
      size: buffer.length,
      storage: 's3',
    };
  }

  const absolute = path.join(env.uploadsDir, key);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, buffer);
  return {
    key,
    url: `/uploads/${key.split(path.sep).join('/')}`,
    originalName: originalName || path.basename(key),
    mimeType: contentType,
    size: buffer.length,
    storage: 'local',
  };
}

async function deleteStoredObject(key, storage = 's3') {
  if (!key) return;

  if (storage === 's3' && env.s3.enabled) {
    const client = createS3Client();
    await client
      .send(
        new DeleteObjectCommand({
          Bucket: env.s3.bucket,
          Key: key,
        })
      )
      .catch(() => {});
    return;
  }

  let absolute;
  try {
    absolute = insideUploads(key);
  } catch {
    return;
  }
  await fs.promises.unlink(absolute).catch(() => {});
}

async function readStoredObject(key, storage = 'local') {
  if (!key) return null;
  if (storage === 's3') {
    const client = createS3Client();
    if (!client) return null;
    const out = await client.send(new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  }
  return fs.readFileSync(insideUploads(key));
}

// Keys are joined onto the uploads folder; refuse anything that escapes it.
function insideUploads(key) {
  const root = path.resolve(env.uploadsDir);
  const absolute = path.resolve(root, String(key));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error('Stored file path is outside the uploads folder');
  }
  return absolute;
}

// Sends a file returned by a service: { buffer | filePath, originalName }.
function sendStoredFile(res, file) {
  const name = file.originalName || 'download';
  const type = contentTypeFor(name);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  if (file.buffer) {
    res.setHeader('Content-Type', type);
    res.attachment(name);
    return res.send(file.buffer);
  }
  return res.download(file.filePath, name, { headers: { 'Content-Type': type } });
}

module.exports = {
  uploadBuffer,
  deleteStoredObject,
  readStoredObject,
  sendStoredFile,
  contentTypeFor,
  publicUrlForKey,
  isS3Enabled: () => env.s3.enabled,
};
