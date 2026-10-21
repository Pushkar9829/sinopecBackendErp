// Account groups (the standard Indian layout, as in Tally) and the accounts
// every company starts with. `nature` decides the side of the trial balance
// and where the group goes in the final statements.
const GROUPS = [
  { id: 'capital', label: 'Capital account', nature: 'equity' },
  { id: 'reserves', label: 'Reserves & surplus', nature: 'equity' },
  { id: 'loans', label: 'Loans (liability)', nature: 'liability' },
  { id: 'sundry_creditors', label: 'Sundry creditors', nature: 'liability' },
  { id: 'duties_taxes', label: 'Duties & taxes', nature: 'liability' },
  { id: 'provisions', label: 'Provisions', nature: 'liability' },
  { id: 'current_liabilities', label: 'Other current liabilities', nature: 'liability' },
  { id: 'fixed_assets', label: 'Fixed assets', nature: 'asset' },
  { id: 'investments', label: 'Investments', nature: 'asset' },
  { id: 'sundry_debtors', label: 'Sundry debtors', nature: 'asset' },
  { id: 'bank', label: 'Bank accounts', nature: 'asset' },
  { id: 'cash', label: 'Cash in hand', nature: 'asset' },
  { id: 'stock', label: 'Stock in hand', nature: 'asset' },
  { id: 'loans_advances', label: 'Loans & advances (asset)', nature: 'asset' },
  { id: 'deposits', label: 'Deposits (asset)', nature: 'asset' },
  { id: 'current_assets', label: 'Other current assets', nature: 'asset' },
  { id: 'sales', label: 'Sales accounts', nature: 'income' },
  { id: 'direct_income', label: 'Direct income', nature: 'income' },
  { id: 'indirect_income', label: 'Indirect income', nature: 'income' },
  { id: 'purchases', label: 'Purchase accounts', nature: 'expense' },
  { id: 'direct_expenses', label: 'Direct expenses', nature: 'expense' },
  { id: 'indirect_expenses', label: 'Indirect expenses', nature: 'expense' },
  { id: 'suspense', label: 'Suspense', nature: 'liability' },
];
const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));

// Accounts the app posts to by itself (looked up by `key`).
const SYSTEM_ACCOUNTS = [
  { key: 'cash', name: 'Cash in hand', group: 'cash' },
  { key: 'bank', name: 'Bank account', group: 'bank' },
  { key: 'sales', name: 'Sales', group: 'sales' },
  { key: 'output_cgst', name: 'Output CGST', group: 'duties_taxes' },
  { key: 'output_sgst', name: 'Output SGST', group: 'duties_taxes' },
  { key: 'output_igst', name: 'Output IGST', group: 'duties_taxes' },
  { key: 'input_cgst', name: 'Input CGST', group: 'duties_taxes' },
  { key: 'input_sgst', name: 'Input SGST', group: 'duties_taxes' },
  { key: 'input_igst', name: 'Input IGST', group: 'duties_taxes' },
  { key: 'round_off', name: 'Round off', group: 'indirect_expenses' },
  { key: 'capital', name: 'Capital account', group: 'capital' },
  { key: 'purchases', name: 'Purchases', group: 'purchases' },
  { key: 'sales_returns', name: 'Sales returns & allowances', group: 'sales' },
  { key: 'bad_debts', name: 'Bad debts written off', group: 'indirect_expenses' },
  { key: 'tds_receivable', name: 'TDS receivable (deducted by customers)', group: 'loans_advances' },
  { key: 'tds_payable', name: 'TDS payable', group: 'duties_taxes' },
];

// Common heads, created once so the first expenses can be entered at once.
const STARTER_ACCOUNTS = [
  { name: 'Wages', group: 'direct_expenses' },
  { name: 'Power & fuel', group: 'direct_expenses' },
  { name: 'Freight & cartage', group: 'direct_expenses' },
  { name: 'Salaries', group: 'indirect_expenses' },
  { name: 'Rent', group: 'indirect_expenses' },
  { name: 'Repairs & maintenance', group: 'indirect_expenses' },
  { name: 'Office expenses', group: 'indirect_expenses' },
  { name: 'Bank charges', group: 'indirect_expenses' },
  { name: 'Interest received', group: 'indirect_income' },
];

function natureOf(group) {
  return GROUP_BY_ID.get(group)?.nature || 'asset';
}

module.exports = { GROUPS, GROUP_BY_ID, SYSTEM_ACCOUNTS, STARTER_ACCOUNTS, natureOf };
