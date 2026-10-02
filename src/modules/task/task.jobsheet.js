const { stageRequirements } = require('../production/production.flow');

const join = (...parts) => parts.map((part) => String(part || '').trim()).filter(Boolean).join(' × ');
const words = (...parts) => parts.map((part) => String(part || '').trim()).filter(Boolean).join(' ');
const qty = (value, unit) => (value == null || value === '' ? '' : `${Math.round(Number(value) * 1000) / 1000} ${unit || ''}`.trim());

function field(key, label, value, extra = {}) {
  const text = value == null ? '' : String(value).trim();
  return text ? { key, label, value: text, ...extra } : null;
}

function stageFields(order, item, stage) {
  const m = item.manufacturing || {};
  const roll = item.roll || {};
  const bag = item.bag || {};
  const print = item.printing || {};
  const holes = item.holes || {};
  const tape = item.tape || {};
  const rollSize = roll.size || join(roll.width, roll.length);
  const req = stageRequirements(order, item, stage);
  const available = req.availableInput != null && req.incomingOutput ? qty(req.availableInput, req.incomingOutput.unit) : '';

  if (stage === 'rolling') {
    return [
      field('size', 'Size', item.size),
      field('thickness', 'Thickness', m.thickness || item.thickness),
      field('colour', 'Colour', m.color || item.color),
      field('material', 'Material', item.material),
      field('rawMaterial', 'Raw material', m.rawMaterial),
      field('materialType', 'Material type', m.materialType),
      field('grade', 'Grade', m.materialGrade),
      field('requiredWeight', 'Required weight', m.requiredWeight),
      field('requiredQuantity', 'Required quantity', m.requiredQuantity),
      field('width', 'Width', m.width || item.width),
      field('length', 'Length', m.length || item.length),
      field('rollSize', 'Roll size', rollSize),
      field('rollWeight', 'Roll weight', roll.weight),
      field('additives', 'Additives', m.additives),
      field('special', 'Special requirements', m.specialRequirements, { long: true }),
    ];
  }
  if (stage === 'printing') {
    return [
      field('jobSize', 'Job size', item.size),
      field('colours', 'Print colours', print.colors),
      field('colourCount', 'No. of colours', print.colorCount),
      field('impression', 'Impression', print.impressions),
      field('artwork', 'Artwork', print.artwork),
      field('design', 'Design', print.design),
      field('requirement', 'Print requirement', print.requirement),
      field('rollSize', 'Roll size', rollSize),
      field('baseColour', 'Film colour', item.color || m.color),
      field('thickness', 'Thickness', m.thickness || item.thickness),
      field('available', 'Ready from previous stage', available),
      field('special', 'Special requirements', print.specialRequirements || m.specialRequirements, { long: true }),
    ];
  }
  if (stage === 'cutting') {
    return [
      field('bagSize', 'Bag size', bag.size || join(bag.width, bag.length) || item.size),
      field('gusset', 'Gusset', bag.gusset),
      field('hole', 'Hole', holes.required ? words(holes.count, holes.type, holes.size) : 'No'),
      field('holePosition', 'Hole position', holes.required ? holes.position : ''),
      field('tape', 'Tape', tape.required ? tape.type || 'Yes' : 'No'),
      field('printed', 'Printed', print.required ? words(print.colors, print.design && `(${print.design})`) || 'Yes' : 'No'),
      field('rollSize', 'Roll size', rollSize),
      field('thickness', 'Thickness', m.thickness || item.thickness),
      field('available', 'Ready from previous stage', available),
      field('special', 'Special requirements', holes.specialRequirements || m.specialRequirements, { long: true }),
    ];
  }
  return [];
}

function stageJob(order, item, stage) {
  const pickup = item.stagePickup?.stage === stage && Number(item.stagePickup.qty) > 0 ? item.stagePickup : null;
  return {
    product: item.product || '',
    productCode: item.productCode || '',
    customerCode: order.customerSnapshot?.code || '',
    orderQuantity: qty(item.quantity, item.unit),
    deliveryDate: order.deliveryDate || null,
    fields: stageFields(order, item, stage).filter(Boolean),
    instructions: order.productionInstructions || '',
    workingNow: pickup ? `${pickup.pickedByName || 'Someone'} has ${qty(pickup.qty, pickup.unit)} picked up` : '',
  };
}

function dispatchJob(order) {
  return {
    product: (order.items || []).map((item) => item.product).filter(Boolean).join(', '),
    productCode: '',
    customerCode: order.customerSnapshot?.code || '',
    orderQuantity: (order.items || []).map((item) => qty(item.quantity, item.unit)).join(' + '),
    deliveryDate: order.deliveryDate || null,
    fields: [
      field('deliveryLocation', 'Deliver to', order.deliveryLocation || order.shippingAddress, { long: true }),
      field('deliveryInstructions', 'Delivery instructions', order.deliveryInstructions, { long: true }),
      field('contact', 'Contact person', order.customerSnapshot?.contactPerson),
      field('items', 'Items', (order.items || []).map((item, index) => `#${index + 1} ${item.product} · ${qty(item.quantity, item.unit)}`).join('\n'), {
        long: true,
      }),
    ].filter(Boolean),
    instructions: '',
    workingNow: '',
  };
}

module.exports = { stageJob, dispatchJob };
