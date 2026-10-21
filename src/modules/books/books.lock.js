const ApiError = require('../../utils/ApiError');
const { businessYmd } = require('../../utils/businessTime');
const { BooksSettings } = require('./books.models');
const { ensureChart } = require('./books.post');

// A locked period (a filed GST month, a closed year) cannot change: nothing
// dated on or before the lock date can be added, cancelled or voided.
async function assertOpenPeriod(date, what = 'an entry dated then') {
  if (!date) return;
  await ensureChart();
  const s = await BooksSettings.findOne({ key: 'default' }).select('lockDate').lean();
  if (s?.lockDate && new Date(date) <= s.lockDate) {
    throw new ApiError(400, `The books are locked up to ${businessYmd(s.lockDate)}; ${what} cannot be changed. Ask the owner to unlock the period if this is a correction.`);
  }
}

module.exports = { assertOpenPeriod };
