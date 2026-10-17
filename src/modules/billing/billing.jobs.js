const jobs = require('../../utils/jobQueue');
const billing = require('./billing.service');

const HOUR = 60 * 60 * 1000;

function registerBillingJobs() {
  jobs.register('billing:overdue', () => billing.syncOverdueTasks());
}

async function startBillingJobs() {
  registerBillingJobs();
  await jobs.ensureRecurring('billing:overdue', 6 * HOUR);
}

module.exports = { registerBillingJobs, startBillingJobs };
