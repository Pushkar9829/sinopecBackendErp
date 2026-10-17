const crypto = require('crypto');
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

module.exports = { storeInlineImage, storeProductPhotos, storeListPhotos, hasInlinePhoto, parseDataUrl };
