const mongoose = require('mongoose');
const { businessYmd, endOfBusinessDay } = require('../../../utils/businessTime');
const gemini = require('./gemini');
const claude = require('./claude');
const openaiCompatible = require('./openaiCompatible');

const PROVIDERS = { gemini, claude, openai: openaiCompatible };

// One row per AI call: what it cost in tokens and whether it worked.
const usageSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    day: { type: String, required: true },
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
    intake: { type: mongoose.Schema.Types.ObjectId, ref: 'Intake', default: null },
    ok: { type: Boolean, default: true },
    error: { type: String, default: '' },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    ms: { type: Number, default: 0 },
  },
  { versionKey: false }
);
usageSchema.index({ day: 1 });
usageSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
const AiUsage = mongoose.models.IntakeAiUsage || mongoose.model('IntakeAiUsage', usageSchema);

class DailyLimitReached extends Error {
  constructor(limit) {
    super(`The daily reading limit (${limit}) is reached. Waiting drafts are read tomorrow.`);
    this.resumeAt = new Date(endOfBusinessDay().getTime() + 60 * 1000);
  }
}

async function usedToday() {
  return AiUsage.countDocuments({ day: businessYmd() });
}

async function callProvider(name, settings, input, intakeId) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown AI provider ${name}`);
  const started = Date.now();
  try {
    const result = await provider.read(settings, input);
    await AiUsage.create({
      day: businessYmd(),
      provider: name,
      model: result.model,
      intake: intakeId,
      ok: true,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      ms: Date.now() - started,
    });
    return { ...result, provider: name };
  } catch (error) {
    if (!error.config) {
      await AiUsage.create({
        day: businessYmd(),
        provider: name,
        intake: intakeId,
        ok: false,
        error: String(error.message).slice(0, 500),
        ms: Date.now() - started,
      });
    }
    throw error;
  }
}

// Reads with the chosen provider; on failure tries the fallback provider once.
async function readOrder(settings, input, intakeId) {
  const limit = Number(settings.dailyReadLimit) || 0;
  if (limit > 0 && (await usedToday()) >= limit) throw new DailyLimitReached(limit);
  const primary = settings.aiProvider || 'gemini';
  try {
    return await callProvider(primary, settings, input, intakeId);
  } catch (error) {
    const fallback = settings.aiFallbackProvider;
    if (!fallback || fallback === primary) throw error;
    const result = await callProvider(fallback, settings, input, intakeId);
    result.warning = `${primary} failed (${error.message}); read by ${fallback} instead.`;
    return result;
  }
}

async function usageSummary(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await AiUsage.aggregate([
    { $match: { at: { $gte: since } } },
    {
      $group: {
        _id: { day: '$day', provider: '$provider' },
        calls: { $sum: 1 },
        failed: { $sum: { $cond: ['$ok', 0, 1] } },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
      },
    },
    { $sort: { '_id.day': -1 } },
  ]);
  return {
    today: await usedToday(),
    days: rows.map((row) => ({ day: row._id.day, provider: row._id.provider, calls: row.calls, failed: row.failed, inputTokens: row.inputTokens, outputTokens: row.outputTokens })),
  };
}

function providerSupportsPdf(name) {
  return Boolean(PROVIDERS[name]?.supportsPdf);
}

module.exports = { readOrder, usageSummary, providerSupportsPdf, DailyLimitReached, AiUsage };
