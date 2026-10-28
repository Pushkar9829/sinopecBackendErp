const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const h = require('./helpers');

// How the plant's customers write orders: the reader's clean-up of sizes
// (the third number is the flap), units, quantities, gauge / micron,
// material and features; carrying them into the sales order; follow-up mails
// read as not an order; and a second order in one WhatsApp chat. The AI
// reader is a local fake; nothing leaves this machine.
const formats = require('../src/modules/intake/intake.formats');
const { normalizeProposal, applyMessageFacts } = require('../src/modules/intake/intake.reader');

let aiAnswer = () => ({ lines: [], isOrder: true });
let fake;
let db;
let owner;
let service;

function startFake() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (!req.url.includes(':generateContent')) {
          res.writeHead(404);
          return res.end('{}');
        }
        const json = JSON.parse(body);
        const text = json.contents[0].parts.map((p) => p.text || '').join('\n');
        const answer = { customer: {}, certainty: { customer: 'low', lines: 'medium' }, warnings: [], ...aiAnswer(text.slice(text.indexOf('Message:'))) };
        res.writeHead(200);
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// One line as the model might send it, then the reader's clean-up.
function read(line, message = '') {
  const base = { product: '', quantity: null, unit: '', rate: null, material: '', width: '', length: '', notes: '' };
  return normalizeProposal({ lines: [{ ...base, ...line }] }, [], { message }).lines[0];
}

function sized(line) {
  return { width: line.width, length: line.length, flap: line.flap, gusset: line.gusset, sizeUnit: line.sizeUnit };
}

test('size: the third number of every W x L + N spelling is the flap, in inches unless written', () => {
  const cases = [
    ['9.5 x 13 + 2', '9.5', '13'],
    ['13x15+2', '13', '15'],
    ['9.5W X14L +2"', '9.5', '14'],
    ['12*18-2', '12', '18'],
    ['11x14.5+2inch', '11', '14.5'],
    ['10X12X2', '10', '12'],
    ['13X18X2 IN', '13', '18'],
    ['9.5 by 13 + 2', '9.5', '13'],
    ['14X20X2', '14', '20'],
  ];
  for (const [text, width, length] of cases) {
    // From the size text the model copied, and from a size left in the product name.
    assert.deepEqual(sized(read({ product: 'Poly bag', sizeText: text })), { width, length, flap: '2', gusset: '', sizeUnit: 'inch' }, text);
    assert.deepEqual(sized(read({ product: `LD Poly bag ${text}` })), { width, length, flap: '2', gusset: '', sizeUnit: 'inch' }, `in product: ${text}`);
  }
  // A model that still calls the third number a gusset is corrected.
  assert.deepEqual(sized(read({ width: '10', length: '14', gusset: '2', sizeText: '10x14x2' }, '10x14x2 500 pcs')), { width: '10', length: '14', flap: '2', gusset: '', sizeUnit: 'inch' });
  assert.deepEqual(sized(read({ width: '12x18', length: '' })), { width: '12', length: '18', flap: '', gusset: '', sizeUnit: 'inch' }, 'a size stuffed into width');
});

test('gusset only when the text says gusset; odd values from a PO table are not kept', () => {
  assert.deepEqual(sized(read({ product: 'Mailer bag', sizeText: '12x16', notes: 'flap 2, gusset 1' })), { width: '12', length: '16', flap: '2', gusset: '1', sizeUnit: 'inch' });
  assert.deepEqual(sized(read({ sizeText: '10x14x2 gusset' })), { width: '10', length: '14', flap: '', gusset: '2', sizeUnit: 'inch' });
  const mm = read({ product: 'Mailer bag', sizeText: '410X730MM', notes: 'gusset 50 MM' });
  assert.deepEqual(sized(mm), { width: '410', length: '730', flap: '', gusset: '50', sizeUnit: 'mm' });
  // The model read a table column into gusset: kept when the PO has a GUSSET column, flagged when it can't be right.
  const table = 'WIDTH LENGTH FLAP GUSSET\n12 16 2 1';
  assert.deepEqual(sized(read({ width: '12', length: '16', flap: '2', gusset: '1' }, table)), { width: '12', length: '16', flap: '2', gusset: '1', sizeUnit: 'inch' });
  const odd = read({ width: '12', length: '16', gusset: '14 INCH' }, 'gusset 14 INCH');
  assert.equal(odd.gusset, '');
  assert.match(odd.notes, /Check gusset: 14/);
  const word = read({ width: '12', length: '16', gusset: 'INCH' }, 'Gusset: INCH');
  assert.equal(word.gusset, '');
  assert.match(word.notes, /Check gusset/);
  // No gusset word anywhere, a flap already there: the stray number goes to notes.
  const stray = read({ width: '12', length: '16', flap: '2', gusset: '3' }, '12x16 flap 2');
  assert.deepEqual([stray.flap, stray.gusset], ['2', '']);
  assert.match(stray.notes, /gusset 3\?/);
});

test('sizes in mm and cm keep their unit; a roll, sheet or film can have one size', () => {
  assert.deepEqual(sized(read({ sizeText: '520 x 750 mm' })), { width: '520', length: '750', flap: '', gusset: '', sizeUnit: 'mm' });
  assert.deepEqual(sized(read({ product: 'Mailer 410X730MM' })), { width: '410', length: '730', flap: '', gusset: '', sizeUnit: 'mm' });
  assert.deepEqual(sized(read({ sizeText: '30x40cm' })), { width: '30', length: '40', flap: '', gusset: '', sizeUnit: 'cm' });
  assert.deepEqual(sized(read({ width: '520 mm', length: '750 mm' })), { width: '520', length: '750', flap: '', gusset: '', sizeUnit: 'mm' }, 'unit taken off the numbers');
  assert.deepEqual(sized(read({ product: 'Sheet roll', sizeText: '24 INCH' })), { width: '24', length: '', flap: '', gusset: '', sizeUnit: 'inch' });
  assert.deepEqual(sized(read({ product: 'Sheet roll 24"' })), { width: '24', length: '', flap: '', gusset: '', sizeUnit: 'inch' });
  assert.deepEqual(sized(read({ product: '19 INCH STRETCH FILM' })), { width: '19', length: '', flap: '', gusset: '', sizeUnit: 'inch' });
  const adhesive = read({ product: 'Courier bag', notes: 'Adhesive 15 mm' });
  assert.equal(adhesive.width, '', 'an adhesive strip is not a size');
});

test('units and quantities as customers write them', () => {
  assert.equal(read({ quantity: 500, unit: 'PCS-PCS-Pieces' }).unit, 'pcs');
  for (const unit of ['Kilograms', 'KGS', 'Kg']) assert.equal(read({ quantity: 200, unit }).unit, 'kg', unit);
  assert.equal(read({ quantity: 3, unit: 'Box' }).unit, 'box');
  assert.equal(read({ quantity: 10, unit: 'Rolls' }).unit, 'roll');
  assert.equal(read({ quantity: 10, unit: 'Mtrs' }).unit, 'mtr');
  const kg = read({ quantity: '4.55 KGS' });
  assert.deepEqual([kg.quantity, kg.unit], [4.55, 'kg']);
  const approx = read({ quantity: '12500 (Aprox)', unit: 'pcs' });
  assert.equal(approx.quantity, 12500);
  assert.match(approx.notes, /Approx/);
  assert.equal(read({ quantity: '9,000', unit: 'pcs' }).quantity, 9000);
  assert.equal(read({ quantity: '2k' }).quantity, 2000);
  assert.equal(read({ quantity: '1.5 lakh' }).quantity, 150000);
  assert.equal(read({ quantity: '90 Kilograms' }).unit, 'kg');
  // From message text when the reader found nothing.
  for (const [text, quantity, unit] of [
    ['Qty 500', 500, ''],
    ['12500 (Aprox) mailer bags', 12500, ''],
    ['4000 pcs', 4000, 'pcs'],
    ['Quantity: 750pcs', 750, 'pcs'],
    ['Required qty-5 kgs', 5, 'kg'],
    ['LD Poly bag -11x14.5+2inch Qty-9,000 pcs', 9000, 'pcs'],
  ]) {
    const found = formats.findQuantity(text);
    assert.deepEqual([found.quantity, found.unit], [quantity, unit], text);
  }
  assert.equal(formats.findQuantity('12500 (Aprox) mailer bags').approx, true);
  assert.equal(formats.findQuantity('Tell me about the rate. 5000 pcs').approx, false, 'approx only next to the number');
});

test('thickness: gauge, the misspelt gauze, micron / MIC, and 160G in a polybag name', () => {
  const thick = (line) => [read(line).thickness, read(line).thicknessKind];
  assert.deepEqual(thick({ product: 'Poly bag', notes: '150 gauge' }), [150, 'gauge']);
  assert.deepEqual(thick({ product: 'Poly bag 325 gauze' }), [325, 'gauge']);
  assert.deepEqual(thick({ product: 'Stretch film', notes: '51 Microns' }), [51, 'micron']);
  assert.deepEqual(thick({ product: 'Stretch film 52 Micron' }), [52, 'micron']);
  assert.deepEqual(thick({ product: 'Stretch film', sizeText: '19 INCH', notes: '9 MIC' }), [9, 'micron']);
  assert.deepEqual(thick({ thickness: 10, thicknessKind: 'micron' }), [10, 'micron']);
  assert.deepEqual(thick({ thickness: '150 gauge' }), [150, 'gauge']);
  const gram = read({ product: 'POLYBAG LD NORMAL PRINTED 160G' });
  assert.deepEqual([gram.thickness, gram.thicknessKind, gram.product], [160, 'gauge', 'POLYBAG LD NORMAL PRINTED']);
  assert.equal(read({ product: 'POLYBAG 250G' }).thickness, 250);
  assert.equal(read({ product: 'Garbage bag 5G network' }).thickness, null, 'not a thickness');
});

test('material and features: LDPE / PP, recycled kept, tidy notes', () => {
  assert.equal(read({ material: 'LD' }).material, 'LDPE');
  assert.equal(read({ material: 'ldpe' }).material, 'LDPE');
  assert.equal(read({ material: 'pp' }).material, 'PP');
  assert.equal(read({ product: 'LD Poly bag' }).material, 'LDPE');
  assert.equal(read({ product: 'PP bag' }).material, 'PP');
  assert.equal(read({ material: 'LDPE', notes: 'with 40% recycled material' }).material, 'LDPE, 40% recycled');
  assert.equal(read({ material: 'LD', notes: 'RCS' }).material, 'LDPE, recycled (RCS)');
  assert.equal(read({ material: 'LDPE recycled' }).material, 'LDPE, recycled');
  const line = read({ product: 'Courier bag printed', notes: 'self-adhesive 15 mm, 2 punch holes, WITH TUBE HOLE' });
  // The customer's own wording stays; only missing features are added.
  assert.match(line.notes, /self-adhesive 15 mm/i);
  assert.match(line.notes, /2 punch holes/);
  assert.match(line.notes, /tube hole/i);
  assert.match(line.notes, /Printed$/);
  assert.equal(read({ product: 'Courier bag', notes: 'adhesive tape 15mm, holes: 2 punch holes' }).notes.match(/adhesive/gi).length, 1, 'not repeated');
  assert.match(read({ product: 'Plain blister bag' }).notes, /Plain\. Blister/);
});

test('message facts: one-line orders, PO number, references, delivery', () => {
  const doc = (body, extra = {}) => ({ messages: [{ body, receivedAt: new Date() }], sender: { name: 'Buyer' }, files: [], ...extra });
  const empty = () => normalizeProposal({ lines: [] }, [], { message: '' });

  const one = applyMessageFacts(empty(), doc('LD Poly bag -11x14.5+2inch Qty-9,000 pcs 150 gauge with 2 punch holes po-7321'));
  assert.equal(one.lines.length, 1);
  const line = one.lines[0];
  assert.deepEqual([line.quantity, line.unit, line.width, line.length, line.flap, line.sizeUnit, line.thickness, line.thicknessKind, line.material], [9000, 'pcs', '11', '14.5', '2', 'inch', 150, 'gauge', 'LDPE']);
  assert.match(line.notes, /2 punch holes/);
  assert.equal(one.poNumber, 'po-7321');
  assert.equal(one.isOrder, true);

  const erp = applyMessageFacts(
    empty(),
    doc('We are pleased to place an order with you as attached PO. Delivery Date : 26-Oct-2026\nPPO/A-12/27/98 Job No: 665833/002//JO/26-27/1328 style no-aimee SO No: GPI/000406/26-27', { files: [{ originalName: 'po.pdf' }] })
  );
  assert.equal(erp.poNumber, 'PPO/A-12/27/98');
  assert.equal(erp.deliveryDate, '2026-10-26');
  assert.match(erp.notes, /Job No 665833\/002\/\/JO\/26-27\/1328/);
  assert.match(erp.notes, /Style no aimee/);
  assert.match(erp.notes, /SO No GPI\/000406\/26-27/);
  assert.equal(erp.isOrder, true, 'attached PO stays an order');

  const weekday = applyMessageFacts(empty(), doc('Poly bag 10x14 5000 pcs. Needed by Tuesday 27/10'));
  assert.equal(weekday.deliveryDate, '');
  assert.match(weekday.notes, /Delivery: .*Tuesday 27\/10/);

  for (const body of ['Kindly send via porter', 'Paid.', 'We sent a 45-day pdc cheque', 'Please confirm the goods-ready date', 'Please share bank details', '']) {
    const read = applyMessageFacts(empty(), doc(body));
    assert.equal(read.isOrder, false, JSON.stringify(body));
  }
  assert.equal(applyMessageFacts(empty(), doc('PFA', { files: [{ originalName: 'po.pdf' }] })).isOrder, true);
  assert.equal(applyMessageFacts(empty(), doc('Paid. Also send 5000 pcs poly bag 10x14')).isOrder, true, 'a follow-up with a new quantity stays');
});

test('old drafts keep their notes: a saved "gusset 2" note is not rewritten', () => {
  const saved = normalizeProposal({ lines: [{ product: 'Poly bag', quantity: 500, unit: 'pcs', width: '10', length: '14', notes: 'gusset 2' }] });
  assert.deepEqual([saved.lines[0].notes, saved.lines[0].flap, saved.lines[0].gusset], ['gusset 2', '', '']);
});

// ---------------------------------------------------------------- with the app

before(async () => {
  fake = await startFake();
  process.env.GEMINI_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  service = require('../src/modules/intake/intake.service');
  const saved = await owner.put('/api/intake/settings', { geminiApiKey: 'gemini-test-key', aiProvider: 'gemini' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
});

after(async () => {
  require('../src/utils/jobQueue').stop();
  await new Promise((r) => fake.close(r));
  await h.stopApp();
});

let seq = 0;
async function incoming(channel, body, { key, files = [] } = {}) {
  seq += 1;
  const sender = channel === 'gmail' ? { email: `buyer${seq}@example.com`, name: 'Buyer' } : { phone: key, name: 'Buyer' };
  const { doc } = await service.ingestMessage({
    channel,
    conversationKey: key || `thread-${seq}`,
    windowMs: channel === 'whatsapp' ? 60 * 60 * 1000 : 0,
    message: { providerMessageId: `${channel}-fmt-${seq}`, from: sender.email || sender.phone, fromName: 'Buyer', subject: channel === 'gmail' ? 'Re: order' : '', body, receivedAt: new Date() },
    files,
    sender,
    potentialOrder: true,
  });
  return doc;
}

async function readNow(doc) {
  await service.runRead({ intakeId: String(doc._id) }, { attempts: 1, maxAttempts: 1 });
  return db.collection('intakes').findOne({ _id: doc._id });
}

test('convert carries flap, gusset, size unit and thickness into the sales order item', async () => {
  const customer = await db.collection('customers').findOne({ isActive: { $ne: false } });
  const line = { product: 'Mailer bag', quantity: 1000, unit: 'pcs', rate: 2, material: 'LDPE', width: '12', length: '16', flap: '2', gusset: '1', sizeUnit: 'inch', sizeText: '12x16+2', thickness: 150, thicknessKind: 'gauge', notes: '' };
  const mm = { product: 'Stretch mailer', quantity: 500, unit: 'pcs', rate: 3, material: 'LDPE', width: '410', length: '730', flap: '40', gusset: '', sizeUnit: 'mm', sizeText: '410X730MM', thickness: 51, thicknessKind: 'micron', notes: 'Printed' };
  const created = await owner.post('/api/intake/panel', { proposal: { customer: { name: 'Format Buyer' }, lines: [line, mm] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual([created.data.data.proposal.lines[0].flap, created.data.data.proposal.lines[0].gusset, created.data.data.proposal.lines[1].thicknessKind], ['2', '1', 'micron'], 'saved as typed');
  const confirmed = await owner.post(`/api/intake/${created.data.data.id}/customer`, { customerId: String(customer._id), version: created.data.data.version });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  const draft = confirmed.data.data;
  const res = await owner.post(`/api/intake/${draft.id}/convert`, {
    version: draft.version,
    lines: draft.proposal.lines.map((l) => ({ ...l, productionRoute: 'roll_cut_dispatch' })),
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const order = await db.collection('salesorders').findOne({ _id: h.asId(res.data.data.order.id) });
  const [inch, metric] = order.items;
  assert.deepEqual([inch.width, inch.length, inch.flap, inch.bag.gusset, inch.bag.width, inch.roll.width, inch.thickness], ['12', '16', '2', '1', '12', '12', '150']);
  assert.equal(inch.size, '12 × 16 inch');
  // Weight formula counts half the flap: 12 × (16 + 1) × 150 ÷ 3300 kg per 1,000 pcs.
  assert.equal(Number(inch.manufacturing.requiredWeight), Math.round(((12 * 17 * 150) / 3300) * 100) / 100);
  assert.deepEqual([metric.width, metric.length, metric.flap, metric.thickness], ['410 mm', '730 mm', '40 mm', '204']);
  assert.match(metric.manufacturing.specialRequirements, /Thickness 51 micron/);
  assert.match(metric.manufacturing.specialRequirements, /Printed/);
});

test('follow-up mails are stored as not an order, unless a person edited the draft or confirmed the customer', async () => {
  aiAnswer = () => ({ lines: [], isOrder: true });
  for (const body of ['Kindly send via porter', 'Paid.', 'We sent a 45-day pdc cheque', 'Please confirm the goods-ready date']) {
    const after = await readNow(await incoming('gmail', body));
    assert.equal(after.status, 'stored', body);
    assert.equal(after.potentialOrder, false);
  }
  const blank = await readNow(await incoming('gmail', ''));
  assert.equal(blank.status, 'stored', 'empty body, no attachment');

  // Edited by a person: the draft stays where it is.
  const edited = await incoming('gmail', 'Paid.');
  await db.collection('intakes').updateOne({ _id: edited._id }, { $set: { humanEdited: true, status: 'needs_review', proposal: { customer: {}, lines: [] } } });
  assert.equal((await readNow(edited)).status, 'needs_review');

  // Customer already confirmed: stays too.
  const customer = await db.collection('customers').findOne({ isActive: { $ne: false } });
  const linked = await incoming('gmail', 'Kindly send via porter');
  await db.collection('intakes').updateOne({ _id: linked._id }, { $set: { customer: customer._id, status: 'customer_confirmed' } });
  assert.equal((await readNow(linked)).status, 'customer_confirmed');

  // "PFA" with the PO attached is an order: the file is read.
  const { uploadBuffer } = require('../src/utils/storage');
  const file = await uploadBuffer({ buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), originalName: 'po.png', mimeType: 'image/png', folder: 'intake' });
  aiAnswer = () => ({ lines: [{ product: 'Poly bag', quantity: 5000, unit: 'PCS', width: '10', length: '14', flap: '2', sizeText: '10x14+2', notes: '' }], isOrder: true });
  const pfa = await readNow(await incoming('gmail', 'PFA', { files: [file] }));
  assert.equal(pfa.status, 'needs_review');
  assert.deepEqual([pfa.proposal.lines[0].unit, pfa.proposal.lines[0].flap], ['pcs', '2']);
});

test('WhatsApp: "create a sales order of …" after a read draft opens a new draft; "make it 5000" stays', async () => {
  const phone = '919811100001';
  aiAnswer = (text) => {
    const qty = formats.findQuantity(text);
    const size = formats.parseSize(text);
    return { lines: qty ? [{ product: 'LD Poly bag', quantity: qty.quantity, unit: qty.unit, width: size?.width || '', length: size?.length || '', sizeText: size?.text || '', notes: '' }] : [], isOrder: true };
  };
  const first = await readNow(await incoming('whatsapp', 'LD Poly bag -11x14.5+2inch Qty-9,000 pcs', { key: phone }));
  assert.equal(first.status, 'needs_review');
  assert.deepEqual([first.proposal.lines[0].quantity, first.proposal.lines[0].flap], [9000, '2']);

  const change = await incoming('whatsapp', 'make it 5000', { key: phone });
  assert.equal(String(change._id), String(first._id), 'a change joins the same draft');

  const second = await incoming('whatsapp', 'CREATE A SALES ORDER OF Kavya Traders SIZE 12*18-2 QTY 3000 PCS', { key: phone });
  assert.notEqual(String(second._id), String(first._id), 'a new draft');
  const old = await db.collection('intakes').findOne({ _id: first._id });
  assert.equal(old.openKey, undefined, 'the first draft takes no more messages');
  assert.equal(old.messages.length, 2);
  const fresh = await db.collection('intakes').findOne({ _id: second._id });
  assert.match(fresh.history[0].note, new RegExp(`a new order after ${first.number}`));

  // Before the second draft is read, a PO photo joins it.
  const photo = await incoming('whatsapp', '', { key: phone });
  assert.equal(String(photo._id), String(second._id));

  // Once read, a complete new line with a size not on the draft also opens one; the same size does not.
  await readNow(second);
  const same = await incoming('whatsapp', 'LD poly bag 12x18+2 3000 pcs', { key: phone });
  assert.equal(String(same._id), String(second._id), 'same size: a repeat, not a new order');
  const third = await incoming('whatsapp', 'PP bag 14X20X2 2000 pcs', { key: phone });
  assert.notEqual(String(third._id), String(second._id));
});

test('real order lines: the message decides flap vs gusset, thickness and recycled material', () => {
  const f = require('../src/modules/intake/intake.formats');
  const clean = (raw, message) => f.cleanLine({ ...raw }, raw, message);
  const a = clean({ product: 'POLYBAG LD NORMAL PRINTED 160G', quantity: '5000', unit: 'PCS-PCS-Pieces', width: '12', length: '15', material: 'LD', notes: 'gusset 2' }, 'POLYBAG LD NORMAL PRINTED 160G 12x15+2 5000 pcs');
  assert.equal(a.flap, '2');
  assert.equal(a.gusset, '');
  assert.ok(!/gusset/i.test(a.notes), 'the model note "gusset 2" is dropped');
  assert.deepEqual([a.thickness, a.thicknessKind, a.product], [160, 'gauge', 'POLYBAG LD NORMAL PRINTED']);
  const b = clean({ product: 'Myntra Roadster polybag', quantity: '10000', width: '9.5"', length: '13"', material: 'RECYCLE 51 MICRON LD', notes: 'self adhesive 15 mm' }, 'MYNTRA Roadster POLYBAG 9.5 x 13 + 2 RECYCLE 51 MICRON LD self adhesive 15 mm Qty 10000');
  assert.deepEqual([b.flap, b.thickness, b.thicknessKind, b.material], ['2', 51, 'micron', 'LDPE, recycled']);
  const c = clean({ product: 'LD plain POLYBAG', quantity: '50000', unit: 'PCS', width: '520', length: '750', material: 'LD', notes: 'gusset 50 MM GTOP' }, 'LD plain POLYBAG 520x750 mm gusset 50 MM GTOP 50000 PCS');
  assert.deepEqual([c.gusset, c.flap, c.sizeUnit], ['50', '', 'mm']);
  const msg = 'poly bag 9.5x13+2 10000 and 10x14+2 10000';
  assert.equal(clean({ product: 'poly bag', quantity: '10000', width: '9.5', length: '13' }, msg).sizeText, '9.5x13+2');
  assert.equal(clean({ product: 'poly bag', quantity: '10000', width: '10', length: '14' }, msg).sizeText, '10x14+2');
});
