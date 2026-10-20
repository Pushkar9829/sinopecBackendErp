const ApiError = require('../../utils/ApiError');
const { businessYmd, endOfBusinessDay, OFFSET_MINUTES } = require('../../utils/businessTime');

const DAY = 24 * 60 * 60 * 1000;
const OFFSET_MS = OFFSET_MINUTES * 60 * 1000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 3 * 366;

const money = (value) => {
  const n = Number(value) || 0;
  return Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
};

// 00:00 plant time on a YYYY-MM-DD day.
function startOfBusinessDay(ymd) {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) - OFFSET_MS);
}

function addDays(ymd, days) {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

// Start of the Indian financial year (1 April) that contains the day.
function financialYearStart(ymd) {
  const year = Number(ymd.slice(0, 4));
  return `${Number(ymd.slice(5, 7)) >= 4 ? year : year - 1}-04-01`;
}

// Period from ?from=&to= (plant calendar days). Default: this financial year
// to today. Also returns the same-length period just before, for comparison.
function parseRange(query = {}) {
  const today = businessYmd(new Date());
  const from = String(query.from || '') || financialYearStart(today);
  const to = String(query.to || '') || today;
  if (!YMD.test(from) || !YMD.test(to)) throw new ApiError(400, 'Dates must be YYYY-MM-DD');
  if (from > to) throw new ApiError(400, 'The start date is after the end date');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  if (days > MAX_DAYS) throw new ApiError(400, 'Choose a period of at most 3 years');
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(from, -days);
  return {
    from,
    to,
    days,
    start: startOfBusinessDay(from),
    end: endOfBusinessDay(to),
    previous: { from: prevFrom, to: prevTo, start: startOfBusinessDay(prevFrom), end: endOfBusinessDay(prevTo) },
  };
}

// Every month (YYYY-MM) the period touches, in order.
function monthsOf(from, to) {
  const months = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    months.push(key);
    if (key >= last) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

const monthOf = (date) => businessYmd(date).slice(0, 7);
const inRange = (date, range) => {
  const t = new Date(date).getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
};
// Percent change from the previous period; null when there is nothing to compare.
const deltaPct = (current, previous) => (previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null);

module.exports = { parseRange, monthsOf, monthOf, inRange, deltaPct, money, addDays, financialYearStart, DAY };
