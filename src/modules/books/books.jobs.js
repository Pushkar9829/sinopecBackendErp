const jobs = require('../../utils/jobQueue');
const { syncBooks } = require('./books.post');

const MINUTE = 60 * 1000;

// The books also bring themselves up to date whenever they are read; this
// keeps them current between visits, and a full check once at start-up.
function registerBooksJobs() {
  jobs.register('books:sync', () => syncBooks());
}

async function startBooksJobs() {
  registerBooksJobs();
  await syncBooks({ full: true });
  await jobs.ensureRecurring('books:sync', 10 * MINUTE);
}

module.exports = { registerBooksJobs, startBooksJobs };
