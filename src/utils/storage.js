const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DeleteObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const env = require('../config/env');

function safeExt(originalName = '') {
  const ext = path.extname(originalName || '').toLowerCase().slice(0, 12);
  return /^\.[a-z0-9.]+$/.test(ext) ? ext : '';
}

function buildKey(folder, originalName) {
  const cleanFolder = String(folder || 'misc')
    .replace(/[^a-zA-Z0-9/_-]/g, '')
    .replace(/^\/+|\/+$/g, '') || 'misc';
  return `${cleanFolder}/${Date.now()}-${randomUUID()}${safeExt(originalName)}`;
}

function createS3Client() {
  if (!env.s3.enabled) return null;
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

  if (env.s3.enabled) {
    const client = createS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: env.s3.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType || 'application/octet-stream',
      })
    );
    return {
      key,
      url: publicUrlForKey(key),
      originalName: originalName || path.basename(key),
      mimeType: mimeType || '',
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
    mimeType: mimeType || '',
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

  const absolute = path.join(env.uploadsDir, key);
  await fs.promises.unlink(absolute).catch(() => {});
}

module.exports = {
  uploadBuffer,
  deleteStoredObject,
  publicUrlForKey,
  isS3Enabled: () => env.s3.enabled,
};
