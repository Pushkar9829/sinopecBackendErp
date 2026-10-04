// Standalone rate calculator from the "Jai maa packaging" sheet. No database, no link to orders.

// Sheet 2, row 7 (card 261, 20X28, 1+0).
const JOB_WORK_EXAMPLE = {
  printOn: true,
  pcs: '25150',
  printRate: '115',
  printMinimum: '225',
  cutOn: true,
  kg: '858.85',
  cutRate: '5',
  cutMinimum: '100',
  holeOn: false,
  holePcs: '',
  holeRate: '20',
};

// Sheet 3, line 1 (12 x 16 x 150).
const SALES_ORDER_EXAMPLE = {
  width: '12',
  length: '16',
  gauge: '150',
  divisor: '3300',
  materialRate: '160',
};

// Sheet 2 printing chart, ₹ per 1000 pcs. Empty cells have no fixed rate on the sheet.
const PRINT_CHART = {
  bands: [
    { id: 'small', label: '3 to 19 in' },
    { id: 'large', label: '24 in & above' },
  ],
  rows: [
    { colours: '1+0', small: 60, large: 100, minimum: 225 },
    { colours: '1+1', small: 120, large: null, minimum: 375 },
    { colours: '1+2', small: 160, large: 250, minimum: null },
    { colours: '2+2', small: 400, large: 400, minimum: null },
    { colours: '2+3', small: 500, large: 500, minimum: null },
    { colours: '3+3', small: 600, large: 600, minimum: null },
  ],
};

function num(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isBlank(value) {
  return value === '' || value === null || value === undefined;
}

function isOn(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const money = (value) => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = (value) => num(value).toLocaleString('en-IN', { maximumFractionDigits: 4 });

function jobWork(input = {}) {
  const printOn = isOn(input.printOn);
  const cutOn = isOn(input.cutOn);
  const holeOn = isOn(input.holeOn);

  const pcs = num(input.pcs);
  const printBase = (pcs * num(input.printRate)) / 1000;
  const printing = printOn && printBase > 0 ? Math.max(printBase, num(input.printMinimum)) : 0;
  const printMinimumUsed = printing > printBase + 1e-9;

  const cutBase = num(input.kg) * num(input.cutRate);
  const cutting = cutOn && cutBase > 0 ? Math.max(cutBase, num(input.cutMinimum)) : 0;
  const cutMinimumUsed = cutting > cutBase + 1e-9;

  const holePcs = isBlank(input.holePcs) ? pcs : num(input.holePcs);
  const hole = holeOn ? (holePcs * num(input.holeRate)) / 1000 : 0;

  const total = printing + cutting + hole;

  const stages = [
    {
      key: 'printing',
      label: 'Printing',
      included: printOn,
      amount: round(printing),
      minimumApplied: printOn && printMinimumUsed,
      working: printOn
        ? `${plain(input.pcs)} × ${plain(input.printRate)} ÷ 1000 = ${money(printBase)}${printMinimumUsed ? ` → minimum ₹${plain(input.printMinimum)} charged` : ''}`
        : 'Not included',
    },
    {
      key: 'cutting',
      label: 'Cutting',
      included: cutOn,
      amount: round(cutting),
      minimumApplied: cutOn && cutMinimumUsed,
      working: cutOn
        ? `${plain(input.kg)} kg × ${plain(input.cutRate)} = ${money(cutBase)}${cutMinimumUsed ? ` → minimum ₹${plain(input.cutMinimum)} charged` : ''}`
        : 'Not included',
    },
    {
      key: 'hole',
      label: 'Hole',
      included: holeOn,
      amount: round(hole),
      minimumApplied: false,
      working: holeOn ? `${plain(holePcs)} × ${plain(input.holeRate)} ÷ 1000 = ${money(hole)}` : 'Not included',
    },
  ];

  return { stages, total: round(total) };
}

function salesOrder(input = {}) {
  const divisor = num(input.divisor);
  const weight = divisor > 0 ? (num(input.width) * num(input.length) * num(input.gauge)) / divisor : 0;
  const material = weight * num(input.materialRate);
  const kg = weight.toFixed(4);
  return {
    weight: round(weight, 4),
    material: round(material),
    weightWorking: `${plain(input.width)} × ${plain(input.length)} × ${plain(input.gauge)} ÷ ${plain(input.divisor)} = ${kg} kg`,
    materialWorking: `${kg} kg × ₹${plain(input.materialRate)} = ${money(material)}`,
  };
}

const ROLLING_DIVISOR = 3300;
const PIECE_UNITS = ['pc', 'pcs', 'piece', 'pieces', 'no', 'nos'];

function measure(value) {
  const match = String(value ?? '')
    .replace(/,/g, '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
  if (!match) return null;
  return { value: Number(match[1]), unit: match[2].toLowerCase().replace(/\.$/, '').trim() };
}

function inches(value) {
  const parsed = measure(value);
  if (!parsed) return 0;
  if (['', 'in', 'inch', 'inches', '"'].includes(parsed.unit)) return parsed.value;
  if (parsed.unit === 'mm') return parsed.value / 25.4;
  if (parsed.unit === 'cm') return parsed.value / 2.54;
  return 0;
}

// Older orders stored thickness in micron; 1 micron = 4 gauge.
function gauge(value) {
  const parsed = measure(value);
  if (!parsed) return 0;
  if (['', 'g', 'gauge', 'gage'].includes(parsed.unit)) return parsed.value;
  if (['mic', 'micron', 'microns', 'µ', 'µm'].includes(parsed.unit)) return parsed.value * 4;
  return 0;
}

function rolling(input = {}) {
  const width = inches(input.width);
  const length = inches(input.length);
  const gaugeValue = gauge(input.gauge);
  const rate = num(input.materialRate);
  const weightPer1000 = (width * length * gaugeValue) / ROLLING_DIVISOR;
  const unit = String(input.unit || 'pcs').trim().toLowerCase();
  const pcs = PIECE_UNITS.includes(unit) ? num(input.quantity) : 0;
  const totalWeight = (weightPer1000 * pcs) / 1000;
  const ready = weightPer1000 > 0;
  return {
    ready,
    weightPer1000: round(weightPer1000, 4),
    totalWeight: round(totalWeight),
    materialPer1000: round(weightPer1000 * rate),
    totalMaterial: round(totalWeight * rate),
    weightWorking: ready
      ? `${plain(width)} × ${plain(length)} × ${plain(gaugeValue)} ÷ ${ROLLING_DIVISOR} = ${weightPer1000.toFixed(4)} kg per 1,000 pcs`
      : '',
    totalWorking: ready && pcs > 0 ? `${weightPer1000.toFixed(4)} kg × ${plain(pcs)} pcs ÷ 1000 = ${totalWeight.toFixed(2)} kg` : '',
  };
}

function defaults() {
  return { jobWork: { ...JOB_WORK_EXAMPLE }, salesOrder: { ...SALES_ORDER_EXAMPLE }, printChart: PRINT_CHART };
}

module.exports = { jobWork, salesOrder, rolling, defaults };
