// One-time move of product photos stored inline (base64 "dataUrl") into S3.
//
//   node src/scripts/migrateInlinePhotos.js            -> dry run: counts only, changes nothing
//   node src/scripts/migrateInlinePhotos.js --apply    -> uploads to S3 and replaces each photo with its link
//
// Covers sales orders (line items), customers (saved products) and saved
// product templates. Each photo is uploaded once (identical photos share one
// file). Only the photo fields of each record are updated, so it is safe to
// run while the app is in use, and safe to run again (already-moved photos are
// skipped). Use --allow-local only for testing without S3 (files go to /uploads).
require('../config/env');
const mongoose = require('mongoose');
const env = require('../config/env');
const { connectDb } = require('../config/db');
const { storeInlineImage } = require('../utils/inlineImages');

const APPLY = process.argv.includes('--apply');
const ALLOW_LOCAL = process.argv.includes('--allow-local');

const inline = (image) => Boolean(image && typeof image === 'object' && image.dataUrl && !image.url);

// Field updates for one product-like object found at `prefix` (e.g. "items.3").
async function photoUpdates(product, prefix, cache, stats) {
  const set = {};
  if (inline(product.image)) {
    stats.photos += 1;
    stats.bytes += product.image.dataUrl.length;
    if (APPLY) set[`${prefix}image`] = await storeInlineImage(product.image, cache);
  }
  if (Array.isArray(product.images) && product.images.some(inline)) {
    const next = [];
    for (const image of product.images) {
      if (inline(image)) {
        stats.photos += 1;
        stats.bytes += image.dataUrl.length;
        next.push(APPLY ? await storeInlineImage(image, cache) : image);
      } else {
        next.push(image);
      }
    }
    if (APPLY) set[`${prefix}images`] = next;
  }
  return set;
}

async function migrateArrayField(collection, field, cache) {
  const stats = { records: 0, photos: 0, bytes: 0, updated: 0, skipped: 0 };
  const cursor = collection.find(
    { $or: [{ [`${field}.image.dataUrl`]: { $regex: '^data:' } }, { [`${field}.images.dataUrl`]: { $regex: '^data:' } }] },
    { projection: { [field]: 1, number: 1, name: 1 } }
  );
  for await (const doc of cursor) {
    stats.records += 1;
    const list = doc[field] || [];
    for (let index = 0; index < list.length; index += 1) {
      const product = list[index];
      const set = await photoUpdates(product, `${field}.${index}.`, cache, stats);
      if (!APPLY || !Object.keys(set).length) continue;
      // Only if that array slot still holds the same product (it may have been
      // edited or reordered since we read it).
      const guard = product._id ? { [`${field}.${index}._id`]: product._id } : {};
      const result = await collection.updateOne({ _id: doc._id, ...guard }, { $set: set });
      if (result.matchedCount) stats.updated += 1;
      else stats.skipped += 1;
    }
  }
  return stats;
}

async function migrateTemplates(collection, cache) {
  const stats = { records: 0, photos: 0, bytes: 0, updated: 0, skipped: 0 };
  const cursor = collection.find(
    { $or: [{ 'image.dataUrl': { $regex: '^data:' } }, { 'images.dataUrl': { $regex: '^data:' } }] },
    { projection: { image: 1, images: 1, name: 1 } }
  );
  for await (const doc of cursor) {
    stats.records += 1;
    const set = await photoUpdates(doc, '', cache, stats);
    if (APPLY && Object.keys(set).length) {
      await collection.updateOne({ _id: doc._id }, { $set: set });
      stats.updated += 1;
    }
  }
  return stats;
}

function report(label, stats) {
  const mb = (stats.bytes / 1024 / 1024).toFixed(1);
  console.log(
    `${label.padEnd(18)} records ${String(stats.records).padStart(5)}  photos ${String(stats.photos).padStart(5)}  ~${mb} MB inline` +
      (APPLY ? `  updated ${stats.updated}${stats.skipped ? `, skipped ${stats.skipped} (changed meanwhile; run again)` : ''}` : '')
  );
}

async function main() {
  if (APPLY && !env.s3.enabled && !ALLOW_LOCAL) {
    throw new Error('S3 is not configured (AWS_* and bucket env vars). Refusing to move photos. Use --allow-local only for testing.');
  }
  await connectDb();
  const db = mongoose.connection.db;
  const cache = new Map();
  console.log(APPLY ? `Moving inline photos to ${env.s3.enabled ? `S3 bucket ${env.s3.bucket}` : 'local /uploads'}...` : 'Dry run (nothing is changed). Add --apply to move the photos.');
  report('Sales orders', await migrateArrayField(db.collection('salesorders'), 'items', cache));
  report('Customers', await migrateArrayField(db.collection('customers'), 'products', cache));
  report('Saved products', await migrateTemplates(db.collection('producttemplates'), cache));
  if (APPLY) console.log(`Uploaded ${cache.size} distinct photo file(s).`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
