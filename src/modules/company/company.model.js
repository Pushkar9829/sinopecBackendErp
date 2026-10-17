const mongoose = require('mongoose');

// The business's own details: printed on invoices, proformas and statements,
// and the defaults new customers and orders start from. One document.
const companySettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'default' },
    legalName: { type: String, default: 'SINOPEC POLYMERS', trim: true },
    address: { type: String, default: 'Ground Floor, F-3 4/4, Okhla Industrial Area Phase-II', trim: true },
    city: { type: String, default: 'New Delhi', trim: true },
    state: { type: String, default: 'Delhi', trim: true },
    pinCode: { type: String, default: '110020', trim: true },
    gstin: { type: String, default: '', trim: true, uppercase: true },
    pan: { type: String, default: '', trim: true, uppercase: true },
    udyam: { type: String, default: 'UDYAM-DL-08-0047721', trim: true },
    email: { type: String, default: 'sinopecpoly@gmail.com', trim: true },
    phone: { type: String, default: '', trim: true },
    bankName: { type: String, default: '', trim: true },
    bankAccountName: { type: String, default: '', trim: true },
    bankAccountNumber: { type: String, default: '', trim: true },
    bankIfsc: { type: String, default: '', trim: true, uppercase: true },
    bankBranch: { type: String, default: '', trim: true },
    invoicePrefix: { type: String, default: 'SP', trim: true },
    proformaPrefix: { type: String, default: 'PI', trim: true },
    defaultCreditDays: { type: Number, default: 30, min: 0 },
    // Bills this many days past due put a customer's new orders on credit hold.
    overdueHoldDays: { type: Number, default: 30, min: 0 },
    defaultGstPercent: { type: Number, default: 18, min: 0, max: 100 },
    defaultHsnCode: { type: String, default: '3923', trim: true },
    invoiceTerms: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CompanySettings', companySettingsSchema);
