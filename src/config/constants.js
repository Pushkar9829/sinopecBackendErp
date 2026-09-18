const COOKIES = {
  ACCESS: 'accessToken',
  REFRESH: 'refreshToken',
};

const ROLE_SLUGS = {
  SUPER_ADMIN: 'super_admin',
  SALES_MANAGER: 'sales_manager',
  PRODUCTION_MANAGER: 'production_manager',
  INVENTORY_MANAGER: 'inventory_manager',
  ROLLING_OPERATOR: 'rolling_operator',
  PRINTING_OPERATOR: 'printing_operator',
  CUTTING_OPERATOR: 'cutting_operator',
  PACKING_OPERATOR: 'packing_operator',
  DISPATCH_MANAGER: 'dispatch_manager',
  ACCOUNTS: 'accounts',
};

const ROLES = [
  {
    slug: ROLE_SLUGS.SUPER_ADMIN,
    name: 'Super Admin / Owner',
    description: 'Full access to authentication, users, roles, and every future module',
  },
  {
    slug: ROLE_SLUGS.SALES_MANAGER,
    name: 'Sales Manager',
    description: 'Manages sales orders and customer-facing workflows',
  },
  {
    slug: ROLE_SLUGS.PRODUCTION_MANAGER,
    name: 'Production Manager',
    description: 'Oversees the full production floor',
  },
  {
    slug: ROLE_SLUGS.INVENTORY_MANAGER,
    name: 'Inventory / Store Manager',
    description: 'Manages store and inventory stock',
  },
  {
    slug: ROLE_SLUGS.ROLLING_OPERATOR,
    name: 'Rolling Operator',
    description: 'Operates the rolling station',
  },
  {
    slug: ROLE_SLUGS.PRINTING_OPERATOR,
    name: 'Printing Operator',
    description: 'Operates the printing station',
  },
  {
    slug: ROLE_SLUGS.CUTTING_OPERATOR,
    name: 'Cutting Operator',
    description: 'Operates the cutting station',
  },
  {
    slug: ROLE_SLUGS.PACKING_OPERATOR,
    name: 'Packing Operator',
    description: 'Operates the packing station',
  },
  {
    slug: ROLE_SLUGS.DISPATCH_MANAGER,
    name: 'Dispatch Manager',
    description: 'Manages outbound dispatch',
  },
  {
    slug: ROLE_SLUGS.ACCOUNTS,
    name: 'Accounts / Tally',
    description: 'Manages accounts and Tally exports',
  },
];

const AUTH_PERMISSIONS = [
  { key: 'users:create', module: 'users', action: 'create', description: 'Create users' },
  { key: 'users:read', module: 'users', action: 'read', description: 'View users' },
  { key: 'users:update', module: 'users', action: 'update', description: 'Update users' },
  { key: 'users:delete', module: 'users', action: 'delete', description: 'Delete users' },
  { key: 'roles:read', module: 'roles', action: 'read', description: 'View roles' },
  { key: 'roles:update', module: 'roles', action: 'update', description: 'Update role permissions' },
  { key: 'permissions:read', module: 'permissions', action: 'read', description: 'View permissions' },
];

const MODULE_PERMISSIONS = [
  { key: 'sales:*', module: 'sales', action: '*', description: 'All sales access' },
  { key: 'sales:create', module: 'sales', action: 'create', description: 'Create sales records' },
  { key: 'sales:read', module: 'sales', action: 'read', description: 'View sales records' },
  { key: 'sales:update', module: 'sales', action: 'update', description: 'Update sales records' },
  { key: 'sales:delete', module: 'sales', action: 'delete', description: 'Delete sales records' },
  { key: 'production:*', module: 'production', action: '*', description: 'All production access' },
  { key: 'production:create', module: 'production', action: 'create', description: 'Create production records' },
  { key: 'production:read', module: 'production', action: 'read', description: 'View production records' },
  { key: 'production:update', module: 'production', action: 'update', description: 'Update production records' },
  { key: 'production:delete', module: 'production', action: 'delete', description: 'Delete production records' },
  { key: 'production:rolling:*', module: 'production:rolling', action: '*', description: 'All rolling station access' },
  { key: 'production:rolling:read', module: 'production:rolling', action: 'read', description: 'View rolling work' },
  { key: 'production:rolling:update', module: 'production:rolling', action: 'update', description: 'Update rolling work' },
  { key: 'production:printing:*', module: 'production:printing', action: '*', description: 'All printing station access' },
  { key: 'production:printing:read', module: 'production:printing', action: 'read', description: 'View printing work' },
  { key: 'production:printing:update', module: 'production:printing', action: 'update', description: 'Update printing work' },
  { key: 'production:cutting:*', module: 'production:cutting', action: '*', description: 'All cutting station access' },
  { key: 'production:cutting:read', module: 'production:cutting', action: 'read', description: 'View cutting work' },
  { key: 'production:cutting:update', module: 'production:cutting', action: 'update', description: 'Update cutting work' },
  { key: 'production:packing:*', module: 'production:packing', action: '*', description: 'All packing station access' },
  { key: 'production:packing:read', module: 'production:packing', action: 'read', description: 'View packing work' },
  { key: 'production:packing:update', module: 'production:packing', action: 'update', description: 'Update packing work' },
  { key: 'inventory:*', module: 'inventory', action: '*', description: 'All inventory access' },
  { key: 'inventory:create', module: 'inventory', action: 'create', description: 'Create inventory records' },
  { key: 'inventory:read', module: 'inventory', action: 'read', description: 'View inventory records' },
  { key: 'inventory:update', module: 'inventory', action: 'update', description: 'Update inventory records' },
  { key: 'inventory:delete', module: 'inventory', action: 'delete', description: 'Delete inventory records' },
  { key: 'dispatch:*', module: 'dispatch', action: '*', description: 'All dispatch access' },
  { key: 'dispatch:create', module: 'dispatch', action: 'create', description: 'Create dispatch records' },
  { key: 'dispatch:read', module: 'dispatch', action: 'read', description: 'View dispatch records' },
  { key: 'dispatch:update', module: 'dispatch', action: 'update', description: 'Update dispatch records' },
  { key: 'dispatch:delete', module: 'dispatch', action: 'delete', description: 'Delete dispatch records' },
  { key: 'accounts:*', module: 'accounts', action: '*', description: 'All accounts access' },
  { key: 'accounts:create', module: 'accounts', action: 'create', description: 'Create accounts records' },
  { key: 'accounts:read', module: 'accounts', action: 'read', description: 'View accounts records' },
  { key: 'accounts:update', module: 'accounts', action: 'update', description: 'Update accounts records' },
  { key: 'accounts:delete', module: 'accounts', action: 'delete', description: 'Delete accounts records' },
];

const PERMISSIONS = [...AUTH_PERMISSIONS, ...MODULE_PERMISSIONS];

const ROLE_PERMISSION_KEYS = {
  [ROLE_SLUGS.SUPER_ADMIN]: PERMISSIONS.map((permission) => permission.key),
  [ROLE_SLUGS.SALES_MANAGER]: PERMISSIONS.filter((p) => p.module === 'sales').map((p) => p.key),
  [ROLE_SLUGS.PRODUCTION_MANAGER]: PERMISSIONS.filter((p) => p.module === 'production').map((p) => p.key),
  [ROLE_SLUGS.INVENTORY_MANAGER]: PERMISSIONS.filter((p) => p.module === 'inventory').map((p) => p.key),
  [ROLE_SLUGS.ROLLING_OPERATOR]: PERMISSIONS.filter((p) => p.module === 'production:rolling').map((p) => p.key),
  [ROLE_SLUGS.PRINTING_OPERATOR]: PERMISSIONS.filter((p) => p.module === 'production:printing').map((p) => p.key),
  [ROLE_SLUGS.CUTTING_OPERATOR]: PERMISSIONS.filter((p) => p.module === 'production:cutting').map((p) => p.key),
  [ROLE_SLUGS.PACKING_OPERATOR]: PERMISSIONS.filter((p) => p.module === 'production:packing').map((p) => p.key),
  [ROLE_SLUGS.DISPATCH_MANAGER]: PERMISSIONS.filter((p) => p.module === 'dispatch').map((p) => p.key),
  [ROLE_SLUGS.ACCOUNTS]: PERMISSIONS.filter((p) => p.module === 'accounts').map((p) => p.key),
};

const DEMO_PASSWORD = 'Demo@1234';

const PRODUCTION_SHIFTS = [
  { id: 'morning', label: 'Morning' },
  { id: 'afternoon', label: 'Afternoon' },
  { id: 'night', label: 'Night' },
];

const DELIVERY_PARTNERS = ['In-house', 'Delhivery', 'Customer'];

const INVENTORY_CATEGORIES = {
  RAW: 'raw',
  OUTPUT: 'output',
  WASTE: 'waste',
};

const DEFAULT_STAGES = [
  { slug: 'rolling', name: 'Rolling' },
  { slug: 'printing', name: 'Printing' },
  { slug: 'cutting', name: 'Cutting' },
  { slug: 'packing', name: 'Packing' },
  { slug: 'dispatch', name: 'Dispatch' },
  { slug: 'delivery', name: 'Delivery' },
];

const PRODUCTION_ROUTES = {
  ROLL_DISPATCH: 'roll_dispatch',
  ROLL_PRINT_DISPATCH: 'roll_print_dispatch',
  ROLL_PRINT_CUT_DISPATCH: 'roll_print_cut_dispatch',
  ROLL_CUT_DISPATCH: 'roll_cut_dispatch',
};

const PRODUCTION_ROUTE_LIST = [
  {
    id: PRODUCTION_ROUTES.ROLL_DISPATCH,
    label: 'Rolling → Dispatch → Delivery',
    stages: ['rolling', 'dispatch', 'delivery'],
  },
  {
    id: PRODUCTION_ROUTES.ROLL_PRINT_DISPATCH,
    label: 'Rolling → Printing → Dispatch → Delivery',
    stages: ['rolling', 'printing', 'dispatch', 'delivery'],
  },
  {
    id: PRODUCTION_ROUTES.ROLL_PRINT_CUT_DISPATCH,
    label: 'Rolling → Printing → Cutting → Dispatch → Delivery',
    stages: ['rolling', 'printing', 'cutting', 'dispatch', 'delivery'],
  },
  {
    id: PRODUCTION_ROUTES.ROLL_CUT_DISPATCH,
    label: 'Rolling → Cutting → Dispatch → Delivery',
    stages: ['rolling', 'cutting', 'dispatch', 'delivery'],
  },
];

const SALES_ORDER_STATUSES = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  PRODUCTION_PLANNED: 'production_planned',
  IN_PRODUCTION: 'in_production',
  READY_FOR_PACKING: 'ready_for_packing',
  PACKED: 'packed',
  READY_FOR_DISPATCH: 'ready_for_dispatch',
  DISPATCHED: 'dispatched',
  DELIVERED: 'delivered',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const SALES_ORDER_STATUS_FLOW = [
  SALES_ORDER_STATUSES.DRAFT,
  SALES_ORDER_STATUSES.SUBMITTED,
  SALES_ORDER_STATUSES.APPROVED,
  SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
  SALES_ORDER_STATUSES.IN_PRODUCTION,
  SALES_ORDER_STATUSES.READY_FOR_PACKING,
  SALES_ORDER_STATUSES.PACKED,
  SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
  SALES_ORDER_STATUSES.DISPATCHED,
  SALES_ORDER_STATUSES.DELIVERED,
  SALES_ORDER_STATUSES.COMPLETED,
];

const ORDER_PRIORITIES = {
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
};

const PAYMENT_TERMS = {
  ADVANCE: 'advance',
  CREDIT: 'credit',
  COD: 'cod',
  CUSTOM: 'custom',
};

const PAYMENT_METHODS = {
  CASH: 'cash',
  BANK_TRANSFER: 'bank_transfer',
  CHEQUE: 'cheque',
  UPI: 'upi',
  OTHER: 'other',
};

const ATTACHMENT_KINDS = {
  PO: 'po',
  ARTWORK: 'artwork',
  SPEC: 'spec',
  IMAGE: 'image',
  PDF: 'pdf',
  OTHER: 'other',
};

const SALES_OPTION_GROUPS = [
  { id: 'productType', label: 'Product type' },
  { id: 'material', label: 'Material' },
  { id: 'unit', label: 'Unit' },
  { id: 'color', label: 'Color' },
  { id: 'thickness', label: 'Thickness' },
  { id: 'size', label: 'Size' },
  { id: 'width', label: 'Width' },
  { id: 'length', label: 'Length' },
  { id: 'rawMaterial', label: 'Raw material' },
  { id: 'materialType', label: 'Material type' },
  { id: 'materialGrade', label: 'Material grade' },
  { id: 'additive', label: 'Additives' },
  { id: 'specialRequirement', label: 'Special requirements' },
  { id: 'holeType', label: 'Hole type' },
  { id: 'holeCount', label: 'No. of holes' },
  { id: 'holeSize', label: 'Hole size' },
  { id: 'holePosition', label: 'Hole position' },
  { id: 'tapeType', label: 'Tape type' },
  { id: 'printImpression', label: 'Print impression' },
  { id: 'printColor', label: 'Printing colours' },
  { id: 'printDesign', label: 'Printing design' },
];

const DEFAULT_SALES_OPTIONS = {
  productType: ['Finished Product', 'Semi-finished', 'Roll', 'Bag', 'Poly bag'],
  material: ['HDPE', 'LDPE', 'LLDPE', 'PP', 'HM'],
  unit: ['pcs', 'kg', 'roll', 'm'],
  color: ['Red', 'Black', 'Green', 'Golden', 'Yellow', 'Blue', 'White', 'Natural'],
  thickness: ['40 micron', '50 micron', '60 micron', '75 micron'],
  size: ['10 × 14 inch', '12 × 16 inch', '20 × 30 inch', '25 × 35 inch'],
  width: ['10 inch', '12 inch', '20 inch', '25 inch', '500 mm'],
  length: ['14 inch', '16 inch', '30 inch', '35 inch', '800 m', '1000 m'],
  rawMaterial: ['HDPE granules', 'LDPE granules', 'PP granules'],
  materialType: [
    'LD - Plain',
    'LD - BST',
    'LD - BST 10% Recycled',
    'LD - BST 20% Recycled',
    'LD - Frosted - Filler',
    'LD - Frosted - EVA',
    'PP Poly bag',
    'HM - Poly bag',
  ],
  materialGrade: ['Film grade', 'Bag grade'],
  additive: ['UV stabilizer', 'Slip agent', 'Filler', 'EVA'],
  specialRequirement: ['Half Punch', 'As per Sample', 'Customer logo on front'],
  holeType: ['Punch', 'Butterfly', 'Half Punch', 'Round', 'Die cut', 'C-punch', 'Handle'],
  holeCount: ['1', '2', '3', '4', '5', '6'],
  holeSize: ['8 mm', 'Handle'],
  holePosition: ['Top', 'Top centre', 'Bottom', 'Hanger'],
  tapeType: [
    '11mm Tape',
    '12 mm Tape',
    '13 mm PP line tape',
    '15 mm PP line tape',
    '15 mm Red line Tape',
    '19 mm Tape',
    '13 mm Permanent tape',
    '15 mm Permanent tape',
  ],
  printImpression: [
    '0+1 (Cheta Palla Bottom)',
    '0+1 (Cheta Palla Hanger)',
    '(1+1) - Bottom',
    '(1+1) - Hanger',
    '1+2 - As per Sample',
    '2+2 - As per Sample',
  ],
  printColor: ['Red', 'Black', 'Green', 'Golden', 'Yellow', 'Blue', 'White'],
  printDesign: ['Customer logo', 'Company logo', 'As per Sample'],
};

const SALES_ORDER_VIEW_KEYS = [
  'sales:read',
  'production:read',
  'inventory:read',
  'accounts:read',
];

const ANALYTICS_VIEW_KEYS = ['production:read'];

const DEMO_USERS = [
  {
    username: 'sales',
    fullName: 'Anita Sharma',
    roleSlug: ROLE_SLUGS.SALES_MANAGER,
  },
  {
    username: 'production',
    fullName: 'Rahul Mehta',
    roleSlug: ROLE_SLUGS.PRODUCTION_MANAGER,
  },
  {
    username: 'inventory',
    fullName: 'Sneha Kulkarni',
    roleSlug: ROLE_SLUGS.INVENTORY_MANAGER,
  },
  {
    username: 'rolling',
    fullName: 'Vikram Patil',
    roleSlug: ROLE_SLUGS.ROLLING_OPERATOR,
  },
  {
    username: 'printing',
    fullName: 'Farah Khan',
    roleSlug: ROLE_SLUGS.PRINTING_OPERATOR,
  },
  {
    username: 'cutting',
    fullName: 'Arjun Nair',
    roleSlug: ROLE_SLUGS.CUTTING_OPERATOR,
  },
  {
    username: 'packing',
    fullName: 'Pooja Desai',
    roleSlug: ROLE_SLUGS.PACKING_OPERATOR,
  },
  {
    username: 'dispatch',
    fullName: 'Karan Shah',
    roleSlug: ROLE_SLUGS.DISPATCH_MANAGER,
  },
  {
    username: 'accounts',
    fullName: 'Neha Gupta',
    roleSlug: ROLE_SLUGS.ACCOUNTS,
  },
];

module.exports = {
  COOKIES,
  ROLE_SLUGS,
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSION_KEYS,
  DEMO_PASSWORD,
  DEMO_USERS,
  INVENTORY_CATEGORIES,
  DEFAULT_STAGES,
  PRODUCTION_ROUTES,
  PRODUCTION_ROUTE_LIST,
  PRODUCTION_SHIFTS,
  DELIVERY_PARTNERS,
  SALES_ORDER_STATUSES,
  SALES_ORDER_STATUS_FLOW,
  ORDER_PRIORITIES,
  PAYMENT_TERMS,
  PAYMENT_METHODS,
  ATTACHMENT_KINDS,
  SALES_ORDER_VIEW_KEYS,
  ANALYTICS_VIEW_KEYS,
  SALES_OPTION_GROUPS,
  DEFAULT_SALES_OPTIONS,
};
