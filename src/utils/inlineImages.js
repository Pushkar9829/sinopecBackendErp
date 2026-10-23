const crypto = require('crypto');
const env = require('../config/env');
const ApiError = require('./ApiError');
const { uploadBuffer } = require('./storage');

// Product photos must live in S3 (or /uploads locally), never as base64 text
// inside orders, customers or templates: inline photos made every list that
// reads those records many MB and many seconds slow.

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

function parseDataUrl(value) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(String(value || ''));
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  if (!EXT_BY_MIME[mimeType]) return null;
  return { mimeType, buffer: Buffer.from(match[2], 'base64') };
}

// Folders under /uploads that are served publicly (see app.js).
const PUBLIC_UPLOAD_FOLDERS = new Set(['products', 'artwork', 'misc']);

function s3Bases() {
  const bases = [];
  if (env.s3.publicBaseUrl) bases.push(env.s3.publicBaseUrl.replace(/\/$/, ''));
  if (env.s3.bucket) {
    if (env.s3.region) bases.push(`https://${env.s3.bucket}.s3.${env.s3.region}.amazonaws.com`);
    bases.push(`https://${env.s3.bucket}.s3.amazonaws.com`);
  }
  return bases;
}

// A photo's url, key and storage come back from the browser on every save.
// Keep them only when the url is one of our own files (local /uploads or our
// S3 bucket / CloudFront), and rebuild key and storage from that url, so a
// client cannot point a photo at another site or at someone else's file key.
function trustedImageRef(url) {
  const text = String(url || '').trim();
  if (!text) return null;
  const local = /^\/uploads\/([^?#]+)$/.exec(text);
  if (local) {
    let key;
    try {
      key = decodeURIComponent(local[1]);
    } catch {
      return null;
    }
    const parts = key.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return null;
    if (!PUBLIC_UPLOAD_FOLDERS.has(parts[0]) || parts.length < 2) return null;
    return { url: text, key, storage: 'local' };
  }
  for (const base of s3Bases()) {
    if (text.startsWith(`${base}/`)) {
      const key = text.slice(base.length + 1).split(/[?#]/)[0];
      if (!key || key.split('/').some((part) => !part || part === '..')) return null;
      return { url: text, key, storage: 's3' };
    }
  }
  return null;
}

function sanitizeImageRef(image) {
  if (!image || typeof image !== 'object' || !(image.url || image.key || image.storage)) return image;
  const ref = trustedImageRef(image.url);
  if (ref && ref.key === image.key && ref.storage === image.storage) return image;
  const next = { ...image };
  delete next.key;
  delete next.storage;
  // An unknown web link is kept as a plain link (a saved photo is never
  // erased), but without a key/storage the server never reads, copies or
  // deletes it as its own file. A path into our private upload folders is not
  // a photo anyone can see, so it goes.
  if (ref) Object.assign(next, ref);
  else if (!/^https?:\/\//i.test(String(next.url || ''))) next.url = '';
  return next;
}

// Uploads one inline photo and returns the image pointing at the stored file.
// `cache` (hash -> stored image) avoids uploading the same photo twice.
async function storeInlineImage(image, cache = new Map(), folder = 'products') {
  if (!image || typeof image !== 'object' || image.url || !image.dataUrl) return image;
  const parsed = parseDataUrl(image.dataUrl);
  if (!parsed) return { ...image, dataUrl: '' };
  if (parsed.buffer.length > MAX_PHOTO_BYTES) {
    throw new ApiError(400, 'A product photo is larger than 10 MB. Use a smaller photo.');
  }
  const hash = crypto.createHash('sha256').update(parsed.buffer).digest('hex');
  if (!cache.has(hash)) {
    const base = String(image.originalName || 'photo').replace(/\.[a-z0-9]+$/i, '') || 'photo';
    const stored = await uploadBuffer({
      buffer: parsed.buffer,
      originalName: `${base}${EXT_BY_MIME[parsed.mimeType]}`,
      mimeType: parsed.mimeType,
      folder,
    });
    cache.set(hash, stored);
  }
  const stored = cache.get(hash);
  return {
    ...image,
    url: stored.url,
    key: stored.key,
    storage: stored.storage,
    mimeType: stored.mimeType,
    originalName: image.originalName || stored.originalName,
    dataUrl: '',
  };
}

// Replaces inline photos on a product-like object ({ image, images }) in place.
async function storeProductPhotos(product, cache = new Map()) {
  if (!product || typeof product !== 'object') return false;
  let changed = false;
  if (product.image && typeof product.image === 'object') {
    const clean = sanitizeImageRef(product.image);
    if (clean !== product.image) {
      product.image = clean;
      changed = true;
    }
  }
  if (Array.isArray(product.images)) {
    product.images.forEach((image, i) => {
      const clean = sanitizeImageRef(image);
      if (clean !== image) {
        product.images[i] = clean;
        changed = true;
      }
    });
  }
  if (product.image?.dataUrl && !product.image.url) {
    product.image = await storeInlineImage(product.image, cache);
    changed = true;
  }
  if (Array.isArray(product.images)) {
    for (let i = 0; i < product.images.length; i += 1) {
      const image = product.images[i];
      if (image?.dataUrl && !image.url) {
        product.images[i] = await storeInlineImage(image, cache);
        changed = true;
      }
    }
  }
  return changed;
}

async function storeListPhotos(list, cache = new Map()) {
  let changed = false;
  for (const product of Array.isArray(list) ? list : []) {
    if (await storeProductPhotos(product, cache)) changed = true;
  }
  return changed;
}

function hasInlinePhoto(product) {
  if (!product || typeof product !== 'object') return false;
  if (product.image?.dataUrl && !product.image.url) return true;
  return (product.images || []).some((image) => image?.dataUrl && !image.url);
}

module.exports = { storeInlineImage, storeProductPhotos, storeListPhotos, hasInlinePhoto, parseDataUrl, trustedImageRef, sanitizeImageRef };
