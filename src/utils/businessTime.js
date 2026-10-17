// The plant runs on one local clock (India, UTC+05:30) whatever time zone the
// server is in. Due dates and dated labels use this, not the host's TZ.
function parseOffsetMinutes(value) {
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(String(value || '').trim());
  if (!match) return 330;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

const OFFSET_MINUTES = parseOffsetMinutes(process.env.BUSINESS_UTC_OFFSET || '+05:30');
const OFFSET_MS = OFFSET_MINUTES * 60 * 1000;

// YYYY-MM-DD of the plant's calendar day containing `date`.
function businessYmd(date = new Date()) {
  const time = new Date(date).getTime();
  if (Number.isNaN(time)) return '';
  return new Date(time + OFFSET_MS).toISOString().slice(0, 10);
}

// 23:59:59 plant time on the given day (a Date or a YYYY-MM-DD string).
function endOfBusinessDay(dayOrDate = new Date()) {
  const ymd = typeof dayOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dayOrDate) ? dayOrDate : businessYmd(dayOrDate);
  return new Date(Date.parse(`${ymd}T23:59:59.000Z`) - OFFSET_MS);
}

module.exports = { businessYmd, endOfBusinessDay, OFFSET_MINUTES };
