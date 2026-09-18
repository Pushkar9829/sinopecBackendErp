const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const env = require('../config/env');
const { connectDb } = require('../config/db');
const {
  DEFAULT_STAGES,
  DEFAULT_SALES_OPTIONS,
  DEMO_PASSWORD,
  DEMO_USERS,
  INVENTORY_CATEGORIES,
  PERMISSIONS,
  ROLE_PERMISSION_KEYS,
  ROLES,
  ROLE_SLUGS,
} = require('../config/constants');
const permissionRepo = require('../modules/permission/permission.repo');
const roleRepo = require('../modules/role/role.repo');
const userRepo = require('../modules/user/user.repo');
const stageRepo = require('../modules/inventory/stage.repo');
const itemRepo = require('../modules/inventory/item.repo');
const machineRepo = require('../modules/machine/machine.repo');
const customerRepo = require('../modules/customer/customer.repo');
const salesOrderRepo = require('../modules/salesOrder/salesOrder.repo');
const salesSettingsRepo = require('../modules/salesSettings/salesSettings.repo');
const { snapshotFromCustomer } = require('../modules/customer/customer.service');
const { calcTotals, normalizeItem } = require('../modules/salesOrder/salesOrder.service');
const { activeStage, nextStage, routeStages, stageStats } = require('../modules/production/production.flow');
const { nextCustomerCode, nextSalesOrderNumber } = require('../utils/counter');
const SalesOrder = require('../modules/salesOrder/salesOrder.model');
const Customer = require('../modules/customer/customer.model');
const InventoryItem = require('../modules/inventory/item.model');
const SalesOption = require('../modules/salesSettings/option.model');
const ProductTemplate = require('../modules/salesSettings/template.model');
const {
  DELIVERY_PARTNERS,
  ORDER_PRIORITIES,
  PAYMENT_METHODS,
  PAYMENT_TERMS,
  PRODUCTION_ROUTES,
  SALES_ORDER_STATUSES,
} = require('../config/constants');

async function seedPermissions() {
  const created = [];
  for (const permission of PERMISSIONS) {
    created.push(await permissionRepo.upsertByKey(permission));
  }
  return created;
}

async function seedRoles(permissions) {
  const byKey = new Map(permissions.map((permission) => [permission.key, permission._id]));

  for (const role of ROLES) {
    const existing = await roleRepo.findBySlug(role.slug);
    if (existing) {
      existing.name = role.name;
      existing.description = role.description;
      await existing.save();
      continue;
    }

    const keys = ROLE_PERMISSION_KEYS[role.slug] || [];
    const permissionIds = keys.map((key) => byKey.get(key)).filter(Boolean);
    await roleRepo.upsertBySlug({
      ...role,
      permissions: permissionIds,
    });
  }
}

async function seedSuperAdmin() {
  const existing = await userRepo.findByUsername(env.superAdminUsername);
  if (existing) {
    return existing;
  }

  const role = await roleRepo.findBySlug(ROLE_SLUGS.SUPER_ADMIN);
  if (!role) {
    throw new Error('Super Admin role was not seeded');
  }

  const passwordHash = await bcrypt.hash(env.superAdminPassword, 10);
  return userRepo.create({
    username: env.superAdminUsername.toLowerCase().trim(),
    passwordHash,
    fullName: 'Super Admin',
    role: role._id,
    isActive: true,
  });
}

async function seedDemoUsers() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  for (const demo of DEMO_USERS) {
    const existing = await userRepo.findByUsername(demo.username);
    if (existing) continue;

    const role = await roleRepo.findBySlug(demo.roleSlug);
    if (!role) {
      throw new Error(`Demo role missing: ${demo.roleSlug}`);
    }

    await userRepo.create({
      username: demo.username,
      passwordHash,
      fullName: demo.fullName,
      role: role._id,
      isActive: true,
    });
  }
}

async function seedStages() {
  const bySlug = {};
  for (let index = 0; index < DEFAULT_STAGES.length; index += 1) {
    const stage = DEFAULT_STAGES[index];
    const existing = await stageRepo.findBySlug(stage.slug);
    if (existing) {
      existing.name = stage.name;
      existing.sortOrder = index + 1;
      await existing.save();
      bySlug[stage.slug] = existing;
      continue;
    }
    bySlug[stage.slug] = await stageRepo.upsertBySlug({
      ...stage,
      sortOrder: index + 1,
    });
  }
  return bySlug;
}

async function seedDemoInventory(stagesBySlug) {
  const existingCount = await itemRepo.countAll();
  if (existingCount > 0) return;

  const samples = [
    {
      category: INVENTORY_CATEGORIES.RAW,
      name: 'HDPE granules',
      materialType: 'Polymer',
      unit: 'kg',
      quantity: 2500,
      unitPrice: 85,
      notes: 'Store-side raw stock',
    },
    {
      category: INVENTORY_CATEGORIES.RAW,
      name: 'LDPE granules',
      materialType: 'Polymer',
      unit: 'kg',
      quantity: 1800,
      unitPrice: 92,
      notes: 'Bag-grade granules',
    },
    {
      category: INVENTORY_CATEGORIES.RAW,
      name: 'Printing ink',
      materialType: 'Ink',
      unit: 'litre',
      quantity: 40,
      unitPrice: 320,
    },
    {
      category: INVENTORY_CATEGORIES.RAW,
      name: 'Blue masterbatch',
      materialType: 'Additive',
      unit: 'kg',
      quantity: 120,
      unitPrice: 210,
      notes: 'Colour concentrate',
    },
    {
      category: INVENTORY_CATEGORIES.RAW,
      name: 'Corrugated cartons',
      materialType: 'Packing',
      unit: 'pcs',
      quantity: 400,
      unitPrice: 18,
    },
    {
      category: INVENTORY_CATEGORIES.OUTPUT,
      name: 'Rolled film',
      materialType: 'Film',
      unit: 'm',
      quantity: 1200,
      unitPrice: 12,
      stage: stagesBySlug.rolling?._id,
      notes: 'Catalog rolling output',
    },
    {
      category: INVENTORY_CATEGORIES.OUTPUT,
      name: 'Printed film',
      materialType: 'Film',
      unit: 'm',
      quantity: 1100,
      unitPrice: 18,
      stage: stagesBySlug.printing?._id,
      notes: 'Catalog printing output',
    },
    {
      category: INVENTORY_CATEGORIES.OUTPUT,
      name: 'Cut bags',
      materialType: 'Bag',
      unit: 'pcs',
      quantity: 2400,
      unitPrice: 4.5,
      stage: stagesBySlug.cutting?._id,
      notes: 'Catalog cutting output',
    },
    {
      category: INVENTORY_CATEGORIES.OUTPUT,
      name: 'Packed cartons',
      materialType: 'Finished',
      unit: 'carton',
      quantity: 80,
      unitPrice: 220,
      stage: stagesBySlug.packing?._id,
      notes: 'Catalog packing output',
    },
    {
      category: INVENTORY_CATEGORIES.WASTE,
      name: 'Rolling edge trim',
      materialType: 'Film scrap',
      unit: 'kg',
      quantity: 38,
      unitPrice: null,
      stage: stagesBySlug.rolling?._id,
    },
    {
      category: INVENTORY_CATEGORIES.WASTE,
      name: 'Ink residue',
      materialType: 'Ink',
      unit: 'litre',
      quantity: 2,
      unitPrice: null,
      stage: stagesBySlug.printing?._id,
    },
    {
      category: INVENTORY_CATEGORIES.WASTE,
      name: 'Print scrap film',
      materialType: 'Film scrap',
      unit: 'kg',
      quantity: 16,
      unitPrice: null,
      stage: stagesBySlug.printing?._id,
    },
    {
      category: INVENTORY_CATEGORIES.WASTE,
      name: 'Cutting edge trim',
      materialType: 'Film scrap',
      unit: 'kg',
      quantity: 45,
      unitPrice: null,
      stage: stagesBySlug.cutting?._id,
    },
    {
      category: INVENTORY_CATEGORIES.WASTE,
      name: 'Damaged cartons',
      materialType: 'Packing scrap',
      unit: 'pcs',
      quantity: 12,
      unitPrice: null,
      stage: stagesBySlug.packing?._id,
    },
  ];

  for (const sample of samples) {
    await itemRepo.create({ ...sample, isActive: true, kind: 'catalog' });
  }
}

async function seedDemoMachines(stagesBySlug) {
  const samples = [
    { code: 'RM-01', name: 'Rolling mill 1', stageSlug: 'rolling' },
    { code: 'RM-02', name: 'Rolling mill 2', stageSlug: 'rolling' },
    { code: 'PR-01', name: 'Flexo printer 1', stageSlug: 'printing' },
    { code: 'CT-01', name: 'Slitter cutter 1', stageSlug: 'cutting' },
    { code: 'PK-01', name: 'Packing line 1', stageSlug: 'packing' },
  ];

  const createdByStage = {};
  for (const sample of samples) {
    let machine = await machineRepo.findByCode(sample.code);
    if (!machine) {
      machine = await machineRepo.create({
        name: sample.name,
        code: sample.code,
        isActive: true,
      });
    }
    if (!createdByStage[sample.stageSlug]) createdByStage[sample.stageSlug] = [];
    createdByStage[sample.stageSlug].push(machine._id);
  }

  const userByStage = {
    rolling: await userRepo.findByUsername('rolling'),
    printing: await userRepo.findByUsername('printing'),
    cutting: await userRepo.findByUsername('cutting'),
    packing: await userRepo.findByUsername('packing'),
  };
  const production = await userRepo.findByUsername('production');

  for (const [slug, stage] of Object.entries(stagesBySlug)) {
    if ((stage.machines || []).length) continue;
    const machineIds = createdByStage[slug] || [];
    const userIds = [userByStage[slug]?._id, production?._id].filter(Boolean);
    await stageRepo.updateById(stage._id, { machines: machineIds, users: userIds });
  }
}

async function seedDemoCustomers() {
  const abcProducts = [
    demoItem({}),
    demoItem({
      product: 'Plain film roll',
      productCode: 'FILM-010',
      productType: 'Semi-finished',
      size: '500 mm',
      material: 'HDPE',
      thickness: '40 micron',
      width: '500 mm',
      length: '1000 m',
      color: 'Natural',
      quantity: 20,
      unit: 'roll',
      rate: 1200,
      productionRoute: PRODUCTION_ROUTES.ROLL_DISPATCH,
      manufacturing: {
        rawMaterial: 'HDPE granules',
        materialType: 'Polymer',
        materialGrade: 'Film grade',
        requiredWeight: '400 kg',
        requiredQuantity: '20 rolls',
        width: '500 mm',
        length: '1000 m',
        thickness: '40 micron',
        color: 'Natural',
        additives: '',
        specialRequirements: 'No print, dispatch as rolls',
      },
      roll: { width: '500 mm', length: '1000 m', weight: '20 kg' },
      bag: { width: '', length: '', gusset: '' },
      printing: { required: false, artwork: '', impressions: '', colorCount: '', colors: '', design: '', requirement: '' },
      holes: { required: false, count: '', type: '', size: '', position: '' },
      tape: { required: false, type: '' },
    }),
  ];

  const deltaProducts = [
    demoItem({
      product: 'Printed courier bag',
      productCode: 'BAG-220',
      size: '12 × 16 inch',
      width: '12 inch',
      length: '16 inch',
      quantity: 5000,
      rate: 7,
      productionRoute: PRODUCTION_ROUTES.ROLL_PRINT_DISPATCH,
      manufacturing: {
        rawMaterial: 'LDPE granules',
        materialType: 'Polymer',
        materialGrade: 'Bag grade',
        requiredWeight: '180 kg',
        requiredQuantity: '5000 pcs',
        width: '12 inch',
        length: '16 inch',
        thickness: '50 micron',
        color: 'White',
        additives: '',
        specialRequirements: 'Dispatch as printed rolls',
      },
      bag: { width: '', length: '', gusset: '' },
      printing: {
        required: true,
        artwork: 'Delta_Logo.ai',
        impressions: '1',
        colorCount: '1',
        colors: 'Black',
        design: 'Company logo',
        requirement: 'Single colour',
      },
      holes: { required: false, count: '', type: '', size: '', position: '' },
      tape: { required: false, type: '' },
    }),
    demoItem({
      product: 'Plain cutting bag',
      productCode: 'BAG-080',
      size: '10 × 14 inch',
      width: '10 inch',
      length: '14 inch',
      color: 'Natural',
      quantity: 8000,
      rate: 4.25,
      productionRoute: PRODUCTION_ROUTES.ROLL_CUT_DISPATCH,
      manufacturing: {
        rawMaterial: 'HDPE granules',
        materialType: 'Polymer',
        materialGrade: 'Bag grade',
        requiredWeight: '220 kg',
        requiredQuantity: '8000 pcs',
        width: '10 inch',
        length: '14 inch',
        thickness: '40 micron',
        color: 'Natural',
        additives: '',
        specialRequirements: 'No printing',
      },
      printing: { required: false, artwork: '', impressions: '', colorCount: '', colors: '', design: '', requirement: '' },
      bag: { width: '250 mm', length: '350 mm', gusset: '40 mm' },
      holes: { required: true, count: '1', type: 'Die cut', size: 'Handle', position: 'Top' },
      tape: { required: false, type: '' },
    }),
  ];

  const samples = [
    {
      name: 'ABC Industries',
      companyName: 'ABC Industries Pvt Ltd',
      contactPerson: 'Raj Kumar',
      mobile: '9876543210',
      email: 'raj@abcindustries.example',
      gstNumber: '27AABCU9603R1ZM',
      billingAddress: '12 Industrial Estate, Pune 411019',
      shippingAddress: '12 Industrial Estate, Pune 411019',
      priceCategory: 'Standard',
      products: abcProducts,
    },
    {
      name: 'Delta Plastics',
      companyName: 'Delta Plastics LLP',
      contactPerson: 'Meera Iyer',
      mobile: '9123456780',
      email: 'meera@deltaplastics.example',
      gstNumber: '24AADCD1234F1Z5',
      billingAddress: '88 Ring Road, Ahmedabad 380015',
      shippingAddress: 'Warehouse 4, Sanand, Ahmedabad 382110',
      priceCategory: 'Wholesale',
      products: deltaProducts,
    },
  ];

  const existing = await customerRepo.findAll();
  if (existing.length > 0) {
    for (const sample of samples) {
      const customer = existing.find((row) => row.name === sample.name);
      if (!customer) continue;
      if ((customer.products || []).length > 0) continue;
      await customerRepo.updateById(customer._id, { products: sample.products });
    }
    return customerRepo.findAll();
  }

  const created = [];
  for (const sample of samples) {
    created.push(
      await customerRepo.create({
        ...sample,
        code: await nextCustomerCode(),
        isActive: true,
      })
    );
  }
  return created;
}

function demoItem(overrides) {
  return normalizeItem({
    product: 'Printed Packaging Bag',
    productCode: 'BAG-001',
    productType: 'Finished Product',
    size: '20 × 30 inch',
    material: 'HDPE',
    thickness: '50 micron',
    width: '20 inch',
    length: '30 inch',
    color: 'Blue',
    quantity: 10000,
    unit: 'pcs',
    rate: 5.5,
    discount: 0,
    taxPercent: 18,
    productionRoute: PRODUCTION_ROUTES.ROLL_PRINT_CUT_DISPATCH,
    manufacturing: {
      rawMaterial: 'HDPE granules',
      materialType: 'Polymer',
      materialGrade: 'Film grade',
      requiredWeight: '450 kg',
      requiredQuantity: '10000 pcs',
      width: '20 inch',
      length: '30 inch',
      thickness: '50 micron',
      color: 'Blue',
      additives: 'UV stabilizer',
      specialRequirements: 'Customer logo on front',
    },
    roll: { width: '500 mm', length: '800 m', weight: '50 kg' },
    bag: { width: '300 mm', length: '450 mm', gusset: '50 mm' },
    printing: {
      required: true,
      artwork: 'ABC_Design.pdf',
      impressions: '2',
      colorCount: '2',
      colors: 'Blue, White',
      design: 'Customer logo',
      requirement: '2-color flexo print',
    },
    holes: { required: true, count: '2', type: 'Round', size: '8 mm', position: 'Top centre' },
    tape: { required: true, type: 'Adhesive' },
    ...overrides,
  });
}

function shiftWork({
  stage,
  machine,
  user,
  inputQty,
  outputQty,
  wasteQty,
  shift,
  at,
  notes,
  vehicleNumber = '',
  handoverPerson = '',
  deliveryPartner = '',
}) {
  const workDate = new Date(at);
  return {
    stage,
    machine: machine?._id || null,
    machineName: machine ? `${machine.name} (${machine.code})` : '',
    operator: user?._id || null,
    operatorName: user?.fullName || user?.username || '',
    inputQty,
    outputQty,
    wasteQty,
    shift,
    workDate,
    notes,
    completedAt: workDate,
    vehicleNumber,
    handoverPerson,
    deliveryPartner,
  };
}

function at(day, hour = 10) {
  return `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:20:00+05:30`;
}

function offsetHours(value, hours) {
  if (!value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  date.setHours(date.getHours() + hours);
  return date;
}

function seedPartner(value) {
  const raw = String(value || '').trim();
  if (DELIVERY_PARTNERS.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  if (lower.includes('customer')) return 'Customer';
  if (lower.includes('delhiv') || lower.includes('dtdc') || lower.includes('porter') || lower.includes('blue')) {
    return 'Delhivery';
  }
  return 'In-house';
}

function withDeliveryHandover(stageWork, item, { finishDelivery = false } = {}) {
  const target = Number(item?.quantity) || 0;
  const dispatchOutput = (stageWork || [])
    .filter((row) => row.stage === 'dispatch')
    .reduce((sum, row) => sum + (Number(row.outputQty) || 0), 0);
  const dispatchDone = target > 0 && dispatchOutput >= target - 1e-6;
  const dispatchRows = (stageWork || []).filter((row) => row.stage === 'dispatch');
  const lastDispatch = dispatchRows[dispatchRows.length - 1];

  const rows = [];
  for (const row of stageWork || []) {
    if (row.stage !== 'dispatch') {
      rows.push(row);
      continue;
    }
    rows.push({
      ...row,
      vehicleNumber: '',
      handoverPerson: '',
      deliveryPartner: '',
    });
    if ((finishDelivery && dispatchDone) || row !== lastDispatch) {
      rows.push({
        ...row,
        stage: 'delivery',
        machine: null,
        machineName: '',
        workDate: offsetHours(row.workDate, 2),
        completedAt: offsetHours(row.completedAt || row.workDate, 2),
        notes: `Delivery via ${seedPartner(row.deliveryPartner)}`,
        deliveryPartner: seedPartner(row.deliveryPartner),
      });
    }
  }
  return rows;
}

function withFloorProgress(item, stageWork, options) {
  const next = { ...item, stageWork: withDeliveryHandover(stageWork, item, options) };
  next.currentStage = activeStage(next);
  return next;
}

async function seedWipFromOrder(order) {
  for (const item of order.items || []) {
    const stages = routeStages(item.productionRoute).filter((stage) => stage !== 'delivery');
    for (const stage of stages) {
      const stats = stageStats(item, stage);
      const following = nextStage(item.productionRoute, stage);
      const consumed = following && following !== 'completed' ? stageStats(item, following).input : 0;
      const remaining = Math.max(0, stats.output - consumed);
      const stageDoc = await stageRepo.findBySlug(stage);
      if (!stageDoc) continue;

      if (remaining > 0) {
        await itemRepo.create({
          category: INVENTORY_CATEGORIES.OUTPUT,
          name: `${order.number} · ${item.productCode || item.product || 'item'} · ${stage} output`,
          materialType: item.material || item.manufacturing?.materialType || 'WIP',
          unit: item.unit || 'pcs',
          quantity: remaining,
          unitPrice: 0,
          stage: stageDoc._id,
          notes: `From sales order ${order.number}`,
          isActive: true,
          kind: 'wip',
          wipStage: stage,
          salesOrder: order._id,
          lineItem: item._id,
        });
      }

      if (stats.waste > 0) {
        await itemRepo.create({
          category: INVENTORY_CATEGORIES.WASTE,
          name: `${order.number} · ${item.productCode || item.product || 'item'} · ${stage} waste`,
          materialType: 'Process scrap',
          unit: item.unit || 'pcs',
          quantity: stats.waste,
          unitPrice: null,
          stage: stageDoc._id,
          notes: `Waste from ${order.number}`,
          isActive: true,
          kind: 'wip',
          wipStage: stage,
          salesOrder: order._id,
          lineItem: item._id,
        });
      }
    }
  }
}

async function seedDemoSalesOrders() {
  const existingCount = await salesOrderRepo.countAll();
  if (existingCount > 0) return;

  const customers = await customerRepo.findAll();
  const abc = customers.find((customer) => customer.name === 'ABC Industries') || customers[0];
  const delta = customers.find((customer) => customer.name === 'Delta Plastics') || customers[1] || customers[0];
  const salesUser = await userRepo.findByUsername('sales');
  if (!abc) return;

  const orderDate = new Date('2026-09-14');
  const deliveryDate = new Date('2026-09-25');

  const draftItems = [
    demoItem({}),
    demoItem({
      product: 'Plain film roll',
      productCode: 'FILM-010',
      productType: 'Semi-finished',
      size: '500 mm',
      material: 'HDPE',
      thickness: '40 micron',
      width: '500 mm',
      length: '1000 m',
      color: 'Natural',
      quantity: 20,
      unit: 'roll',
      rate: 1200,
      productionRoute: PRODUCTION_ROUTES.ROLL_DISPATCH,
      manufacturing: {
        rawMaterial: 'HDPE granules',
        materialType: 'Polymer',
        materialGrade: 'Film grade',
        requiredWeight: '400 kg',
        requiredQuantity: '20 rolls',
        width: '500 mm',
        length: '1000 m',
        thickness: '40 micron',
        color: 'Natural',
        additives: '',
        specialRequirements: 'No print, dispatch as rolls',
      },
      roll: { width: '500 mm', length: '1000 m', weight: '20 kg' },
      bag: { width: '', length: '', gusset: '' },
      printing: { required: false, artwork: '', impressions: '', colorCount: '', colors: '', design: '', requirement: '' },
      holes: { required: false, count: '', type: '', size: '', position: '' },
      tape: { required: false, type: '' },
    }),
  ];
  const draftTotals = calcTotals(draftItems, 0, 0);
  const abcSnap = snapshotFromCustomer(abc);

  await salesOrderRepo.create({
    number: await nextSalesOrderNumber(orderDate),
    orderDate,
    customer: abc._id,
    customerSnapshot: abcSnap,
    deliveryDate,
    priority: ORDER_PRIORITIES.HIGH,
    status: SALES_ORDER_STATUSES.DRAFT,
    paymentTerms: PAYMENT_TERMS.CREDIT,
    paymentMethod: PAYMENT_METHODS.BANK_TRANSFER,
    creditDays: 30,
    advanceAmount: 0,
    remainingAmount: draftTotals.remainingAmount,
    paymentRemarks: '',
    billingAddress: abcSnap.billingAddress,
    shippingAddress: abcSnap.shippingAddress,
    deliveryLocation: abcSnap.shippingAddress,
    deliveryInstructions: 'Unload at store gate 2',
    remarks: 'Demo draft order',
    productionInstructions: '50 micron thickness\nBlue base color\n2-color printing\nCustomer logo on front\nDelivery by 25 Sept',
    items: draftItems,
    subtotal: draftTotals.subtotal,
    discount: draftTotals.discount,
    tax: draftTotals.tax,
    grandTotal: draftTotals.grandTotal,
    createdBy: salesUser?._id || null,
  });

  if (!delta) return;

  const submittedItems = [
    demoItem({
      product: 'Printed courier bag',
      productCode: 'BAG-220',
      size: '12 × 16 inch',
      width: '12 inch',
      length: '16 inch',
      quantity: 5000,
      rate: 7,
      productionRoute: PRODUCTION_ROUTES.ROLL_PRINT_DISPATCH,
      manufacturing: {
        rawMaterial: 'LDPE granules',
        materialType: 'Polymer',
        materialGrade: 'Bag grade',
        requiredWeight: '180 kg',
        requiredQuantity: '5000 pcs',
        width: '12 inch',
        length: '16 inch',
        thickness: '50 micron',
        color: 'White',
        additives: '',
        specialRequirements: 'Dispatch as printed rolls',
      },
      bag: { width: '', length: '', gusset: '' },
      printing: {
        required: true,
        artwork: 'Delta_Logo.ai',
        impressions: '1',
        colorCount: '1',
        colors: 'Black',
        design: 'Company logo',
        requirement: 'Single colour',
      },
      holes: { required: false, count: '', type: '', size: '', position: '' },
      tape: { required: false, type: '' },
    }),
    demoItem({
      product: 'Plain cutting bag',
      productCode: 'BAG-080',
      size: '10 × 14 inch',
      width: '10 inch',
      length: '14 inch',
      color: 'Natural',
      quantity: 8000,
      rate: 4.25,
      productionRoute: PRODUCTION_ROUTES.ROLL_CUT_DISPATCH,
      manufacturing: {
        rawMaterial: 'HDPE granules',
        materialType: 'Polymer',
        materialGrade: 'Bag grade',
        requiredWeight: '220 kg',
        requiredQuantity: '8000 pcs',
        width: '10 inch',
        length: '14 inch',
        thickness: '40 micron',
        color: 'Natural',
        additives: '',
        specialRequirements: 'No printing',
      },
      printing: { required: false, artwork: '', impressions: '', colorCount: '', colors: '', design: '', requirement: '' },
      bag: { width: '250 mm', length: '350 mm', gusset: '40 mm' },
      holes: { required: true, count: '1', type: 'Die cut', size: 'Handle', position: 'Top' },
      tape: { required: false, type: '' },
    }),
  ];
  const submittedTotals = calcTotals(submittedItems, 2000, 10000);
  const deltaSnap = snapshotFromCustomer(delta);

  await salesOrderRepo.create({
    number: await nextSalesOrderNumber(orderDate),
    orderDate,
    customer: delta._id,
    customerSnapshot: deltaSnap,
    deliveryDate,
    priority: ORDER_PRIORITIES.NORMAL,
    status: SALES_ORDER_STATUSES.SUBMITTED,
    paymentTerms: PAYMENT_TERMS.ADVANCE,
    paymentMethod: PAYMENT_METHODS.UPI,
    creditDays: 0,
    advanceAmount: 10000,
    remainingAmount: submittedTotals.remainingAmount,
    paymentRemarks: 'Part advance received',
    billingAddress: deltaSnap.billingAddress,
    shippingAddress: deltaSnap.shippingAddress,
    deliveryLocation: deltaSnap.shippingAddress,
    deliveryInstructions: 'Call before delivery',
    remarks: 'Demo submitted order',
    productionInstructions: 'Mix of printed rolls and cut bags. No packing skip — packing still before dispatch.',
    items: submittedItems,
    subtotal: submittedTotals.subtotal,
    discount: submittedTotals.discount,
    tax: submittedTotals.tax,
    grandTotal: submittedTotals.grandTotal,
    createdBy: salesUser?._id || null,
    submittedAt: new Date(),
  });

  const plannedItems = submittedItems.map((item) => ({
    ...item,
    currentStage: 'rolling',
    stageWork: [],
  }));
  const plannedTotals = calcTotals(plannedItems, 0, 0);
  await salesOrderRepo.create({
    number: await nextSalesOrderNumber(orderDate),
    orderDate,
    customer: delta._id,
    customerSnapshot: deltaSnap,
    deliveryDate,
    priority: ORDER_PRIORITIES.URGENT,
    status: SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
    paymentTerms: PAYMENT_TERMS.CREDIT,
    paymentMethod: PAYMENT_METHODS.BANK_TRANSFER,
    creditDays: 15,
    advanceAmount: 0,
    remainingAmount: plannedTotals.remainingAmount,
    billingAddress: deltaSnap.billingAddress,
    shippingAddress: deltaSnap.shippingAddress,
    deliveryLocation: deltaSnap.shippingAddress,
    deliveryInstructions: 'Hold at dispatch until QC call',
    remarks: 'Demo order already on the production floor',
    productionInstructions: 'Start rolling first. Follow each product flow.',
    items: plannedItems,
    subtotal: plannedTotals.subtotal,
    discount: plannedTotals.discount,
    tax: plannedTotals.tax,
    grandTotal: plannedTotals.grandTotal,
    createdBy: salesUser?._id || null,
    submittedAt: new Date(),
    approvedAt: new Date(),
    productionPlannedAt: new Date(),
  });

  const approvedItems = [
    demoItem({
      product: 'Printed packaging bag',
      productCode: 'BAG-001',
      quantity: 6000,
      productionRoute: PRODUCTION_ROUTES.ROLL_PRINT_CUT_DISPATCH,
    }),
  ];
  const approvedTotals = calcTotals(approvedItems, 0, 0);
  await salesOrderRepo.create({
    number: await nextSalesOrderNumber(orderDate),
    orderDate,
    customer: abc._id,
    customerSnapshot: abcSnap,
    deliveryDate,
    priority: ORDER_PRIORITIES.NORMAL,
    status: SALES_ORDER_STATUSES.APPROVED,
    paymentTerms: PAYMENT_TERMS.CREDIT,
    paymentMethod: PAYMENT_METHODS.BANK_TRANSFER,
    creditDays: 21,
    remainingAmount: approvedTotals.remainingAmount,
    billingAddress: abcSnap.billingAddress,
    shippingAddress: abcSnap.shippingAddress,
    deliveryLocation: abcSnap.shippingAddress,
    deliveryInstructions: 'Ready for production planning',
    remarks: 'Demo approved order',
    productionInstructions: 'Full route: rolling, printing, cutting, then dispatch.',
    items: approvedItems.map((item) => ({ ...item, currentStage: '', stageWork: [] })),
    subtotal: approvedTotals.subtotal,
    discount: approvedTotals.discount,
    tax: approvedTotals.tax,
    grandTotal: approvedTotals.grandTotal,
    createdBy: salesUser?._id || null,
    submittedAt: new Date('2026-09-14T08:00:00'),
    approvedAt: new Date('2026-09-14T11:00:00'),
  });

  const rollingUser = await userRepo.findByUsername('rolling');
  const printingUser = await userRepo.findByUsername('printing');
  const cuttingUser = await userRepo.findByUsername('cutting');
  const dispatchUser = await userRepo.findByUsername('dispatch');
  const mill1 = await machineRepo.findByCode('RM-01');
  const mill2 = await machineRepo.findByCode('RM-02');
  const printer = await machineRepo.findByCode('PR-01');
  const cutter = await machineRepo.findByCode('CT-01');

  const floorFilm = withFloorProgress(
    demoItem({
      product: 'Plain film roll',
      productCode: 'FILM-010',
      productType: 'Semi-finished',
      size: '500 mm',
      material: 'HDPE',
      thickness: '40 micron',
      width: '500 mm',
      length: '1000 m',
      color: 'Natural',
      quantity: 20,
      unit: 'roll',
      rate: 1200,
      productionRoute: PRODUCTION_ROUTES.ROLL_DISPATCH,
      manufacturing: {
        rawMaterial: 'HDPE granules',
        materialType: 'Polymer',
        materialGrade: 'Film grade',
        requiredWeight: '400 kg',
        requiredQuantity: '20 rolls',
        width: '500 mm',
        length: '1000 m',
        thickness: '40 micron',
        color: 'Natural',
        additives: '',
        specialRequirements: 'No print, dispatch as rolls',
      },
      roll: { width: '500 mm', length: '1000 m', weight: '20 kg' },
      bag: { width: '', length: '', gusset: '' },
      printing: { required: false, artwork: '', impressions: '', colorCount: '', colors: '', design: '', requirement: '' },
      holes: { required: false, count: '', type: '', size: '', position: '' },
      tape: { required: false, type: '' },
    }),
    [
      shiftWork({
        stage: 'rolling',
        machine: mill1,
        user: rollingUser,
        inputQty: 210,
        outputQty: 12,
        wasteQty: 1,
        shift: 'morning',
        at: at(2, 11),
        notes: 'Day 1 morning — 12 rolls into rolling inventory',
      }),
      shiftWork({
        stage: 'rolling',
        machine: mill2,
        user: rollingUser,
        inputQty: 190,
        outputQty: 8,
        wasteQty: 1,
        shift: 'night',
        at: at(3, 22),
        notes: 'Rolling finished. 20 rolls ready for dispatch',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 3,
        outputQty: 3,
        wasteQty: 0,
        shift: 'afternoon',
        at: at(6, 15),
        notes: 'First truck. 17 rolls still in rolling inventory',
        deliveryPartner: 'In-house',
        handoverPerson: 'Karan Shah',
        vehicleNumber: 'MH-12-AB-4421',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 3,
        outputQty: 3,
        wasteQty: 0,
        shift: 'night',
        at: at(9, 22),
        notes: 'Night dispatch. 14 rolls still in rolling inventory',
        deliveryPartner: 'Porter',
        handoverPerson: 'Karan Shah',
        vehicleNumber: 'MH-12-NT-1902',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 4,
        outputQty: 4,
        wasteQty: 0,
        shift: 'morning',
        at: at(13, 9),
        notes: 'Morning truck. 10 rolls still in rolling inventory',
        deliveryPartner: 'In-house',
        handoverPerson: 'Karan Shah',
        vehicleNumber: 'MH-12-AB-4421',
      }),
    ]
  );

  const floorPrint = withFloorProgress(submittedItems[0], [
    shiftWork({
      stage: 'rolling',
      machine: mill1,
      user: rollingUser,
      inputQty: 90,
      outputQty: 2800,
      wasteQty: 22,
      shift: 'morning',
      at: at(2, 11),
      notes: 'Rolled stock parked for printing',
    }),
    shiftWork({
      stage: 'rolling',
      machine: mill2,
      user: rollingUser,
      inputQty: 70,
      outputQty: 2200,
      wasteQty: 18,
      shift: 'afternoon',
      at: at(3, 16),
      notes: 'Rolling finished. 5000 pcs in rolling inventory',
    }),
    shiftWork({
      stage: 'printing',
      machine: printer,
      user: printingUser,
      inputQty: 900,
      outputQty: 820,
      wasteQty: 18,
      shift: 'night',
      at: at(6, 22),
      notes: 'Night print. Leftover rolling still waiting',
    }),
    shiftWork({
      stage: 'printing',
      machine: printer,
      user: printingUser,
      inputQty: 2000,
      outputQty: 1800,
      wasteQty: 25,
      shift: 'morning',
      at: at(8, 10),
      notes: 'Picked 2000 from rolling. Stock still in rolling inventory for printing',
    }),
    shiftWork({
      stage: 'printing',
      machine: printer,
      user: printingUser,
      inputQty: 700,
      outputQty: 640,
      wasteQty: 14,
      shift: 'afternoon',
      at: at(11, 16),
      notes: 'Afternoon print continuation',
    }),
    shiftWork({
      stage: 'dispatch',
      machine: null,
      user: dispatchUser,
      inputQty: 500,
      outputQty: 500,
      wasteQty: 0,
      shift: 'afternoon',
      at: at(10, 15),
      notes: 'Picked 500 from printing',
      deliveryPartner: 'Delhivery',
      handoverPerson: 'Sanjay More',
      vehicleNumber: 'MH-04-CD-1188',
    }),
    shiftWork({
      stage: 'dispatch',
      machine: null,
      user: dispatchUser,
      inputQty: 400,
      outputQty: 400,
      wasteQty: 0,
      shift: 'morning',
      at: at(15, 9),
      notes: 'Follow-up dispatch from printing inventory',
      deliveryPartner: 'DTDC',
      handoverPerson: 'Karan Shah',
      vehicleNumber: 'MH-04-CD-2210',
    }),
  ]);

  const floorFull = withFloorProgress(
    demoItem({
      product: 'Printed packaging bag',
      productCode: 'BAG-001',
      quantity: 6000,
      manufacturing: {
        rawMaterial: 'HDPE granules',
        materialType: 'Polymer',
        materialGrade: 'Film grade',
        requiredWeight: '270 kg',
        requiredQuantity: '6000 pcs',
        width: '20 inch',
        length: '30 inch',
        thickness: '50 micron',
        color: 'Blue',
        additives: 'UV stabilizer',
        specialRequirements: 'Customer logo on front',
      },
    }),
    [
      shiftWork({
        stage: 'rolling',
        machine: mill1,
        user: rollingUser,
        inputQty: 150,
        outputQty: 3200,
        wasteQty: 28,
        shift: 'morning',
        at: at(2, 11),
        notes: 'Rolling lot 1 into inventory',
      }),
      shiftWork({
        stage: 'rolling',
        machine: mill1,
        user: rollingUser,
        inputQty: 120,
        outputQty: 2800,
        wasteQty: 22,
        shift: 'afternoon',
        at: at(3, 16),
        notes: 'Rolling finished. 6000 pcs ready for printing',
      }),
      shiftWork({
        stage: 'printing',
        machine: printer,
        user: printingUser,
        inputQty: 1100,
        outputQty: 980,
        wasteQty: 22,
        shift: 'night',
        at: at(5, 22),
        notes: 'Night printing from rolling WIP',
      }),
      shiftWork({
        stage: 'printing',
        machine: printer,
        user: printingUser,
        inputQty: 3000,
        outputQty: 2800,
        wasteQty: 30,
        shift: 'morning',
        at: at(8, 10),
        notes: 'Picked 3000 from rolling. Stock still in rolling inventory for printing',
      }),
      shiftWork({
        stage: 'cutting',
        machine: cutter,
        user: cuttingUser,
        inputQty: 700,
        outputQty: 620,
        wasteQty: 18,
        shift: 'night',
        at: at(7, 22),
        notes: 'Night cutting from printed stock',
      }),
      shiftWork({
        stage: 'cutting',
        machine: cutter,
        user: cuttingUser,
        inputQty: 1400,
        outputQty: 1200,
        wasteQty: 25,
        shift: 'afternoon',
        at: at(11, 16),
        notes: 'Picked 1400 from printing. Printed leftover still waiting',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 400,
        outputQty: 400,
        wasteQty: 0,
        shift: 'morning',
        at: at(14, 9),
        notes: 'Picked 400 from cutting',
        deliveryPartner: 'Customer',
        handoverPerson: 'Ravi Patel',
        vehicleNumber: 'GJ-01-RT-2290',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 250,
        outputQty: 250,
        wasteQty: 0,
        shift: 'afternoon',
        at: at(15, 15),
        notes: 'Partial dispatch of cut bags',
        deliveryPartner: 'Blue Dart',
        handoverPerson: 'Karan Shah',
        vehicleNumber: 'MH-12-BD-4410',
      }),
    ]
  );

  const floorCut = withFloorProgress(submittedItems[1], [
    shiftWork({
      stage: 'rolling',
      machine: mill2,
      user: rollingUser,
      inputQty: 80,
      outputQty: 2500,
      wasteQty: 12,
      shift: 'morning',
      at: at(4, 10),
      notes: 'Partial rolling into inventory',
    }),
    shiftWork({
      stage: 'rolling',
      machine: mill2,
      user: rollingUser,
      inputQty: 75,
      outputQty: 2000,
      wasteQty: 10,
      shift: 'afternoon',
      at: at(5, 16),
      notes: '4500 rolled. Stock ready for cutting',
    }),
    shiftWork({
      stage: 'cutting',
      machine: cutter,
      user: cuttingUser,
      inputQty: 600,
      outputQty: 520,
      wasteQty: 16,
      shift: 'night',
      at: at(6, 22),
      notes: 'Night cutting from rolling WIP',
    }),
    shiftWork({
      stage: 'cutting',
      machine: cutter,
      user: cuttingUser,
      inputQty: 1800,
      outputQty: 1500,
      wasteQty: 40,
      shift: 'morning',
      at: at(9, 11),
      notes: 'Picked 1800 from rolling. Rolling leftover still waiting',
    }),
    shiftWork({
      stage: 'dispatch',
      machine: null,
      user: dispatchUser,
      inputQty: 400,
      outputQty: 400,
      wasteQty: 0,
      shift: 'afternoon',
      at: at(12, 15),
      notes: 'Picked 400 from cutting',
      deliveryPartner: 'In-house',
      handoverPerson: 'Imran Shaikh',
      vehicleNumber: 'MH-01-DX-7742',
    }),
    shiftWork({
      stage: 'dispatch',
      machine: null,
      user: dispatchUser,
      inputQty: 300,
      outputQty: 300,
      wasteQty: 0,
      shift: 'night',
      at: at(14, 22),
      notes: 'Night dispatch of cut bags',
      deliveryPartner: 'Delhivery',
      handoverPerson: 'Karan Shah',
      vehicleNumber: 'MH-01-DX-8811',
    }),
  ]);

  const inProductionItems = [floorFilm, floorPrint, floorFull, floorCut];
  const inProductionTotals = calcTotals(inProductionItems, 0, 0);
  const inProduction = await salesOrderRepo.create({
    number: await nextSalesOrderNumber(orderDate),
    orderDate,
    customer: delta._id,
    customerSnapshot: deltaSnap,
    deliveryDate,
    priority: ORDER_PRIORITIES.HIGH,
    status: SALES_ORDER_STATUSES.IN_PRODUCTION,
    paymentTerms: PAYMENT_TERMS.CREDIT,
    paymentMethod: PAYMENT_METHODS.BANK_TRANSFER,
    creditDays: 15,
    remainingAmount: inProductionTotals.remainingAmount,
    billingAddress: deltaSnap.billingAddress,
    shippingAddress: deltaSnap.shippingAddress,
    deliveryLocation: deltaSnap.shippingAddress,
    deliveryInstructions: 'Partial lots already on every stage',
    remarks: 'Demo floor order with rolling, printing, cutting, dispatch, and waste',
    productionInstructions:
      'Each next stage picks leftover WIP from the previous stage inventory. Rolling leftover feeds printing or cutting. Printed leftover feeds cutting. Cut leftover feeds dispatch.',
    items: inProductionItems,
    subtotal: inProductionTotals.subtotal,
    discount: inProductionTotals.discount,
    tax: inProductionTotals.tax,
    grandTotal: inProductionTotals.grandTotal,
    createdBy: salesUser?._id || null,
    submittedAt: new Date('2026-09-14T09:00:00'),
    approvedAt: new Date('2026-09-14T12:00:00'),
    productionPlannedAt: new Date('2026-09-14T13:00:00'),
  });

  await seedWipFromOrder(inProduction);

  const completedBags = withFloorProgress(
    demoItem({
      product: 'Printed packaging bag',
      productCode: 'BAG-001',
      quantity: 8000,
      productionRoute: PRODUCTION_ROUTES.ROLL_PRINT_CUT_DISPATCH,
    }),
    [
      shiftWork({
        stage: 'rolling',
        machine: mill1,
        user: rollingUser,
        inputQty: 140,
        outputQty: 2800,
        wasteQty: 24,
        shift: 'morning',
        at: at(2, 10),
        notes: 'Completed order rolling lot 1',
      }),
      shiftWork({
        stage: 'rolling',
        machine: mill2,
        user: rollingUser,
        inputQty: 130,
        outputQty: 2600,
        wasteQty: 20,
        shift: 'afternoon',
        at: at(3, 16),
        notes: 'Completed order rolling lot 2',
      }),
      shiftWork({
        stage: 'rolling',
        machine: mill1,
        user: rollingUser,
        inputQty: 125,
        outputQty: 2600,
        wasteQty: 18,
        shift: 'night',
        at: at(4, 22),
        notes: 'Rolling finished for completed bag order',
      }),
      shiftWork({
        stage: 'printing',
        machine: printer,
        user: printingUser,
        inputQty: 2700,
        outputQty: 2500,
        wasteQty: 32,
        shift: 'morning',
        at: at(5, 10),
        notes: 'Print lot 1',
      }),
      shiftWork({
        stage: 'printing',
        machine: printer,
        user: printingUser,
        inputQty: 2700,
        outputQty: 2550,
        wasteQty: 28,
        shift: 'afternoon',
        at: at(6, 16),
        notes: 'Print lot 2',
      }),
      shiftWork({
        stage: 'printing',
        machine: printer,
        user: printingUser,
        inputQty: 2600,
        outputQty: 2950,
        wasteQty: 30,
        shift: 'night',
        at: at(7, 22),
        notes: 'Printing finished',
      }),
      shiftWork({
        stage: 'cutting',
        machine: cutter,
        user: cuttingUser,
        inputQty: 2700,
        outputQty: 2550,
        wasteQty: 35,
        shift: 'morning',
        at: at(8, 10),
        notes: 'Cut lot 1',
      }),
      shiftWork({
        stage: 'cutting',
        machine: cutter,
        user: cuttingUser,
        inputQty: 2700,
        outputQty: 2600,
        wasteQty: 28,
        shift: 'afternoon',
        at: at(9, 16),
        notes: 'Cut lot 2',
      }),
      shiftWork({
        stage: 'cutting',
        machine: cutter,
        user: cuttingUser,
        inputQty: 2600,
        outputQty: 2850,
        wasteQty: 22,
        shift: 'night',
        at: at(10, 22),
        notes: 'Cutting finished',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 4000,
        outputQty: 4000,
        wasteQty: 0,
        shift: 'morning',
        at: at(11, 10),
        notes: 'First completed dispatch',
        deliveryPartner: 'In-house',
        handoverPerson: 'Karan Shah',
        vehicleNumber: 'MH-12-AB-8801',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 4000,
        outputQty: 4000,
        wasteQty: 0,
        shift: 'afternoon',
        at: at(12, 15),
        notes: 'Order fully dispatched',
        deliveryPartner: 'Customer',
        handoverPerson: 'Raj Kumar',
        vehicleNumber: 'MH-14-CUST-12',
      }),
    ],
    { finishDelivery: true }
  );
  const completedBagTotals = calcTotals([completedBags], 0, 0);
  const completedBagOrder = await salesOrderRepo.create({
    number: await nextSalesOrderNumber(new Date('2026-09-01')),
    orderDate: new Date('2026-09-01'),
    customer: abc._id,
    customerSnapshot: abcSnap,
    deliveryDate: new Date('2026-09-12'),
    priority: ORDER_PRIORITIES.HIGH,
    status: SALES_ORDER_STATUSES.DELIVERED,
    paymentTerms: PAYMENT_TERMS.CREDIT,
    paymentMethod: PAYMENT_METHODS.BANK_TRANSFER,
    creditDays: 21,
    remainingAmount: completedBagTotals.remainingAmount,
    billingAddress: abcSnap.billingAddress,
    shippingAddress: abcSnap.shippingAddress,
    deliveryLocation: abcSnap.shippingAddress,
    deliveryInstructions: 'Completed demo order with full route history',
    remarks: 'Analytics delivered order 1',
    productionInstructions: 'Full rolling, printing, cutting, dispatch across two weeks.',
    items: [completedBags],
    subtotal: completedBagTotals.subtotal,
    discount: completedBagTotals.discount,
    tax: completedBagTotals.tax,
    grandTotal: completedBagTotals.grandTotal,
    createdBy: salesUser?._id || null,
    submittedAt: new Date('2026-09-01T08:00:00+05:30'),
    approvedAt: new Date('2026-09-01T11:00:00+05:30'),
    productionPlannedAt: new Date('2026-09-01T13:00:00+05:30'),
    completedAt: new Date(at(12, 18)),
  });
  await seedWipFromOrder(completedBagOrder);

  const completedCourier = withFloorProgress(
    demoItem({
      product: 'Printed courier bag',
      productCode: 'BAG-220',
      size: '12 × 16 inch',
      width: '12 inch',
      length: '16 inch',
      quantity: 5000,
      rate: 7,
      productionRoute: PRODUCTION_ROUTES.ROLL_PRINT_DISPATCH,
      manufacturing: {
        rawMaterial: 'LDPE granules',
        materialType: 'Polymer',
        materialGrade: 'Bag grade',
        requiredWeight: '180 kg',
        requiredQuantity: '5000 pcs',
        width: '12 inch',
        length: '16 inch',
        thickness: '50 micron',
        color: 'White',
        additives: '',
        specialRequirements: 'Dispatch as printed rolls',
      },
      bag: { width: '', length: '', gusset: '' },
      printing: {
        required: true,
        artwork: 'Delta_Logo.ai',
        impressions: '1',
        colorCount: '1',
        colors: 'Black',
        design: 'Company logo',
        requirement: 'Single colour',
      },
      holes: { required: false, count: '', type: '', size: '', position: '' },
      tape: { required: false, type: '' },
    }),
    [
      shiftWork({
        stage: 'rolling',
        machine: mill2,
        user: rollingUser,
        inputQty: 95,
        outputQty: 2600,
        wasteQty: 16,
        shift: 'morning',
        at: at(4, 10),
        notes: 'Courier rolling lot 1',
      }),
      shiftWork({
        stage: 'rolling',
        machine: mill2,
        user: rollingUser,
        inputQty: 90,
        outputQty: 2400,
        wasteQty: 14,
        shift: 'night',
        at: at(5, 22),
        notes: 'Courier rolling finished',
      }),
      shiftWork({
        stage: 'printing',
        machine: printer,
        user: printingUser,
        inputQty: 2500,
        outputQty: 2350,
        wasteQty: 22,
        shift: 'morning',
        at: at(7, 10),
        notes: 'Courier print lot 1',
      }),
      shiftWork({
        stage: 'printing',
        machine: printer,
        user: printingUser,
        inputQty: 2500,
        outputQty: 2650,
        wasteQty: 20,
        shift: 'afternoon',
        at: at(8, 16),
        notes: 'Courier printing finished',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 2500,
        outputQty: 2500,
        wasteQty: 0,
        shift: 'morning',
        at: at(10, 9),
        notes: 'Courier dispatch lot 1',
        deliveryPartner: 'Delhivery',
        handoverPerson: 'Farah Khan',
        vehicleNumber: 'MH-04-DL-3301',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 2500,
        outputQty: 2500,
        wasteQty: 0,
        shift: 'afternoon',
        at: at(11, 15),
        notes: 'Courier order completed',
        deliveryPartner: 'Delhivery',
        handoverPerson: 'Karan Shah',
        vehicleNumber: 'MH-04-DL-3301',
      }),
    ],
    { finishDelivery: true }
  );
  const completedCourierTotals = calcTotals([completedCourier], 0, 0);
  const completedCourierOrder = await salesOrderRepo.create({
    number: await nextSalesOrderNumber(new Date('2026-09-03')),
    orderDate: new Date('2026-09-03'),
    customer: delta._id,
    customerSnapshot: deltaSnap,
    deliveryDate: new Date('2026-09-11'),
    priority: ORDER_PRIORITIES.NORMAL,
    status: SALES_ORDER_STATUSES.DELIVERED,
    paymentTerms: PAYMENT_TERMS.ADVANCE,
    paymentMethod: PAYMENT_METHODS.UPI,
    creditDays: 0,
    remainingAmount: completedCourierTotals.remainingAmount,
    billingAddress: deltaSnap.billingAddress,
    shippingAddress: deltaSnap.shippingAddress,
    deliveryLocation: deltaSnap.shippingAddress,
    deliveryInstructions: 'Completed courier-bag demo',
    remarks: 'Analytics delivered order 2',
    productionInstructions: 'Rolling, printing, dispatch. No cutting.',
    items: [completedCourier],
    subtotal: completedCourierTotals.subtotal,
    discount: completedCourierTotals.discount,
    tax: completedCourierTotals.tax,
    grandTotal: completedCourierTotals.grandTotal,
    createdBy: salesUser?._id || null,
    submittedAt: new Date('2026-09-03T08:00:00+05:30'),
    approvedAt: new Date('2026-09-03T10:00:00+05:30'),
    productionPlannedAt: new Date('2026-09-03T11:00:00+05:30'),
    completedAt: new Date(at(11, 17)),
  });
  await seedWipFromOrder(completedCourierOrder);

  const dispatchedCut = withFloorProgress(
    demoItem({
      product: 'Plain cutting bag',
      productCode: 'BAG-080',
      size: '10 × 14 inch',
      width: '10 inch',
      length: '14 inch',
      color: 'Natural',
      quantity: 4500,
      rate: 4.25,
      productionRoute: PRODUCTION_ROUTES.ROLL_CUT_DISPATCH,
      manufacturing: {
        rawMaterial: 'HDPE granules',
        materialType: 'Polymer',
        materialGrade: 'Bag grade',
        requiredWeight: '160 kg',
        requiredQuantity: '4500 pcs',
        width: '10 inch',
        length: '14 inch',
        thickness: '40 micron',
        color: 'Natural',
        additives: '',
        specialRequirements: 'No printing',
      },
      printing: { required: false, artwork: '', impressions: '', colorCount: '', colors: '', design: '', requirement: '' },
      bag: { width: '250 mm', length: '350 mm', gusset: '40 mm' },
      holes: { required: true, count: '1', type: 'Die cut', size: 'Handle', position: 'Top' },
      tape: { required: false, type: '' },
    }),
    [
      shiftWork({
        stage: 'rolling',
        machine: mill1,
        user: rollingUser,
        inputQty: 85,
        outputQty: 2300,
        wasteQty: 14,
        shift: 'morning',
        at: at(8, 10),
        notes: 'Dispatched order rolling lot 1',
      }),
      shiftWork({
        stage: 'rolling',
        machine: mill2,
        user: rollingUser,
        inputQty: 80,
        outputQty: 2200,
        wasteQty: 12,
        shift: 'afternoon',
        at: at(9, 16),
        notes: 'Rolling finished for dispatched order',
      }),
      shiftWork({
        stage: 'cutting',
        machine: cutter,
        user: cuttingUser,
        inputQty: 2300,
        outputQty: 2150,
        wasteQty: 30,
        shift: 'morning',
        at: at(11, 10),
        notes: 'Cut lot 1',
      }),
      shiftWork({
        stage: 'cutting',
        machine: cutter,
        user: cuttingUser,
        inputQty: 2200,
        outputQty: 2350,
        wasteQty: 26,
        shift: 'night',
        at: at(12, 22),
        notes: 'Cutting finished',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 2250,
        outputQty: 2250,
        wasteQty: 0,
        shift: 'morning',
        at: at(14, 9),
        notes: 'First dispatched lot',
        deliveryPartner: 'Delhivery',
        handoverPerson: 'Sanjay More',
        vehicleNumber: 'MH-04-CD-1188',
      }),
      shiftWork({
        stage: 'dispatch',
        machine: null,
        user: dispatchUser,
        inputQty: 2250,
        outputQty: 2250,
        wasteQty: 0,
        shift: 'afternoon',
        at: at(15, 15),
        notes: 'Order handed to delivery partner',
        deliveryPartner: 'Delhivery',
        handoverPerson: 'Karan Shah',
        vehicleNumber: 'MH-04-CD-9090',
      }),
    ]
  );
  const dispatchedTotals = calcTotals([dispatchedCut], 0, 0);
  const dispatchedOrder = await salesOrderRepo.create({
    number: await nextSalesOrderNumber(new Date('2026-09-07')),
    orderDate: new Date('2026-09-07'),
    customer: abc._id,
    customerSnapshot: abcSnap,
    deliveryDate: new Date('2026-09-18'),
    priority: ORDER_PRIORITIES.NORMAL,
    status: SALES_ORDER_STATUSES.DISPATCHED,
    paymentTerms: PAYMENT_TERMS.CREDIT,
    paymentMethod: PAYMENT_METHODS.BANK_TRANSFER,
    creditDays: 15,
    remainingAmount: dispatchedTotals.remainingAmount,
    billingAddress: abcSnap.billingAddress,
    shippingAddress: abcSnap.shippingAddress,
    deliveryLocation: abcSnap.shippingAddress,
    deliveryInstructions: 'Handed to Delhivery with vehicle and person logged',
    remarks: 'Analytics dispatched order',
    productionInstructions: 'Rolling and cutting, then full dispatch with delivery partner.',
    items: [dispatchedCut],
    subtotal: dispatchedTotals.subtotal,
    discount: dispatchedTotals.discount,
    tax: dispatchedTotals.tax,
    grandTotal: dispatchedTotals.grandTotal,
    createdBy: salesUser?._id || null,
    submittedAt: new Date('2026-09-07T08:00:00+05:30'),
    approvedAt: new Date('2026-09-07T11:00:00+05:30'),
    productionPlannedAt: new Date('2026-09-07T12:00:00+05:30'),
  });
  await seedWipFromOrder(dispatchedOrder);
}

async function seedProductionFloor() {
  const onFloor = await salesOrderRepo.countByStatus();
  const already = onFloor.some((row) =>
    [
      SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
      SALES_ORDER_STATUSES.IN_PRODUCTION,
      SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
    ].includes(row._id)
  );
  if (already) return;

  const orders = await salesOrderRepo.findAll({
    status: { $in: [SALES_ORDER_STATUSES.APPROVED, SALES_ORDER_STATUSES.SUBMITTED] },
  });
  const order = orders[0];
  if (!order) return;
  for (const item of order.items || []) {
    item.currentStage = 'rolling';
    item.stageWork = item.stageWork || [];
  }
  order.status = SALES_ORDER_STATUSES.PRODUCTION_PLANNED;
  order.approvedAt = order.approvedAt || new Date();
  order.productionPlannedAt = new Date();
  await salesOrderRepo.save(order);
}

async function seedSalesSettings() {
  for (const [group, values] of Object.entries(DEFAULT_SALES_OPTIONS)) {
    for (const value of values) {
      const existing = await salesSettingsRepo.findOptionByGroupValue(group, value);
      if (!existing) {
        await salesSettingsRepo.createOption({ group, value, isActive: true });
      }
    }
  }

  if ((await salesSettingsRepo.countTemplates()) > 0) return;

  const printedBag = demoItem({});
  await salesSettingsRepo.createTemplate({
    name: 'Printed packaging bag',
    code: printedBag.productCode,
    isActive: true,
    ...printedBag,
  });

  const filmRoll = demoItem({
    product: 'Plain film roll',
    productCode: 'FILM-010',
    productType: 'Semi-finished',
    size: '500 mm',
    material: 'HDPE',
    thickness: '40 micron',
    width: '500 mm',
    length: '1000 m',
    color: 'Natural',
    quantity: 20,
    unit: 'roll',
    rate: 1200,
    productionRoute: PRODUCTION_ROUTES.ROLL_DISPATCH,
    manufacturing: {
      rawMaterial: 'HDPE granules',
      materialType: 'Polymer',
      materialGrade: 'Film grade',
      requiredWeight: '400 kg',
      requiredQuantity: '20 rolls',
      width: '500 mm',
      length: '1000 m',
      thickness: '40 micron',
      color: 'Natural',
      additives: '',
      specialRequirements: 'No print, dispatch as rolls',
    },
    roll: { width: '500 mm', length: '1000 m', weight: '20 kg' },
    bag: { width: '', length: '', gusset: '' },
    printing: { required: false, artwork: '', impressions: '', colorCount: '', colors: '', design: '', requirement: '' },
    holes: { required: false, count: '', type: '', size: '', position: '' },
    tape: { required: false, type: '' },
  });
  await salesSettingsRepo.createTemplate({
    name: 'Plain film roll',
    code: filmRoll.productCode,
    isActive: true,
    ...filmRoll,
  });

  const courierBag = demoItem({
    product: 'Printed courier bag',
    productCode: 'BAG-220',
    size: '12 × 16 inch',
    width: '12 inch',
    length: '16 inch',
    quantity: 5000,
    rate: 7,
    productionRoute: PRODUCTION_ROUTES.ROLL_PRINT_DISPATCH,
    manufacturing: {
      rawMaterial: 'LDPE granules',
      materialType: 'Polymer',
      materialGrade: 'Bag grade',
      requiredWeight: '180 kg',
      requiredQuantity: '5000 pcs',
      width: '12 inch',
      length: '16 inch',
      thickness: '50 micron',
      color: 'White',
      additives: '',
      specialRequirements: 'Dispatch as printed rolls',
    },
    bag: { width: '', length: '', gusset: '' },
    printing: {
      required: true,
      artwork: 'Delta_Logo.ai',
      impressions: '1',
      colorCount: '1',
      colors: 'Black',
      design: 'Company logo',
      requirement: 'Single colour',
    },
    holes: { required: false, count: '', type: '', size: '', position: '' },
    tape: { required: false, type: '' },
  });
  await salesSettingsRepo.createTemplate({
    name: 'Printed courier bag',
    code: courierBag.productCode,
    isActive: true,
    ...courierBag,
  });

  const cuttingBag = demoItem({
    product: 'Plain cutting bag',
    productCode: 'BAG-080',
    size: '10 × 14 inch',
    width: '10 inch',
    length: '14 inch',
    color: 'Natural',
    quantity: 8000,
    rate: 4.25,
    productionRoute: PRODUCTION_ROUTES.ROLL_CUT_DISPATCH,
    manufacturing: {
      rawMaterial: 'HDPE granules',
      materialType: 'Polymer',
      materialGrade: 'Bag grade',
      requiredWeight: '220 kg',
      requiredQuantity: '8000 pcs',
      width: '10 inch',
      length: '14 inch',
      thickness: '40 micron',
      color: 'Natural',
      additives: '',
      specialRequirements: 'No printing',
    },
    printing: { required: false, artwork: '', impressions: '', colorCount: '', colors: '', design: '', requirement: '' },
    bag: { width: '250 mm', length: '350 mm', gusset: '40 mm' },
    holes: { required: true, count: '1', type: 'Die cut', size: 'Handle', position: 'Top' },
    tape: { required: false, type: '' },
  });
  await salesSettingsRepo.createTemplate({
    name: 'Plain cutting bag',
    code: cuttingBag.productCode,
    isActive: true,
    ...cuttingBag,
  });
}

async function resetDemoCollections() {
  await Promise.all([
    SalesOrder.deleteMany({}),
    Customer.deleteMany({}),
    InventoryItem.deleteMany({}),
    SalesOption.deleteMany({}),
    ProductTemplate.deleteMany({}),
  ]);
  await mongoose.connection.collection('counters').deleteMany({});
  console.log('Reset demo customers, sales orders, inventory, and sales settings');
}

async function dropStaleUserEmailIndex() {
  const collection = mongoose.connection.collection('users');
  try {
    await collection.dropIndex('email_1');
    console.log('Dropped stale users.email_1 index');
  } catch (error) {
    // IndexNotFound (27) or NamespaceNotFound (26) when users collection is empty/new
    if (error?.codeName !== 'IndexNotFound' && error?.codeName !== 'NamespaceNotFound' && error?.code !== 27 && error?.code !== 26) {
      throw error;
    }
  }
}

async function seed() {
  await dropStaleUserEmailIndex();
  const permissions = await seedPermissions();
  await seedRoles(permissions);
  await seedSuperAdmin();
  await seedDemoUsers();
  const stages = await seedStages();
  await seedDemoInventory(stages);
  await seedDemoMachines(stages);
  await seedDemoCustomers();
  await seedDemoSalesOrders();
  await seedProductionFloor();
  await seedSalesSettings();
}

if (require.main === module) {
  connectDb()
    .then(() => resetDemoCollections())
    .then(() => seed())
    .then(() => {
      console.log('RBAC seed complete');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Seed failed', error);
      process.exit(1);
    });
}

module.exports = { seed };
