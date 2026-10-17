// One-time move of draft orders saved by the earlier version (one message per
// draft, top-level providerMessageId) to the conversation format.
//
//   node src/scripts/migrateIntakes.js           -> dry run: counts only, changes nothing
//   node src/scripts/migrateIntakes.js --apply   -> converts them
//
// Safe to run again: drafts already converted are skipped. Also removes the old
// unique index on (channel, providerMessageId), which would otherwise refuse the
// second new message on each channel.
require('../config/env');
const mongoose = require('mongoose');
const { connectDb } = require('../config/db');
const Intake = require('../modules/intake/intake.model');

const APPLY = process.argv.includes('--apply');
const OLD_INDEX = 'channel_1_providerMessageId_1';

function converted(doc) {
  const providerMessageId = String(doc.providerMessageId || `legacy-${doc._id}`);
  const files = (doc.files || []).map((file) => ({ ...file, _id: file._id || new mongoose.Types.ObjectId() }));
  const sender = doc.sender || {};
  const at = doc.receivedAt || doc.createdAt || new Date();
  return {
    $set: {
      conversationKey: '',
      messageIds: [providerMessageId],
      messages: [
        {
          _id: new mongoose.Types.ObjectId(),
          providerMessageId,
          from: sender.email || sender.phone || '',
          fromName: sender.name || '',
          subject: doc.subject || '',
          body: doc.rawBody || '',
          headerMessageId: '',
          automated: false,
          fileIds: files.map((file) => file._id),
          receivedAt: at,
        },
      ],
      files,
      lastMessageAt: at,
      readings: [],
      replies: [],
      humanEdited: Boolean(doc.editedAt),
      newReadingAvailable: false,
      readPending: false,
      history: [{ at, byName: 'System', action: 'received', note: 'Imported from the earlier version' }],
    },
    $unset: { providerMessageId: 1 },
  };
}

async function main() {
  await connectDb();
  const collection = mongoose.connection.collection('intakes');
  const indexes = await collection.indexes();
  const hasOldIndex = indexes.some((index) => index.name === OLD_INDEX);
  const legacy = { messageIds: { $exists: false } };
  const total = await collection.countDocuments(legacy);
  console.log(`${mongoose.connection.db.databaseName}: ${total} draft(s) in the old format; old index ${hasOldIndex ? 'present' : 'absent'}.`);
  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to convert.');
    await mongoose.disconnect();
    return;
  }

  if (hasOldIndex) {
    await collection.dropIndex(OLD_INDEX);
    console.log(`Dropped index ${OLD_INDEX}`);
  }
  let done = 0;
  for await (const doc of collection.find(legacy)) {
    await collection.updateOne({ _id: doc._id, messageIds: { $exists: false } }, converted(doc));
    done += 1;
  }
  console.log(`Converted ${done} draft(s).`);
  await Intake.createIndexes();
  console.log('Indexes for the new format are in place.');
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Draft migration failed:', error.message);
  process.exit(1);
});
