const env = require('./config/env');
const { connectDb } = require('./config/db');
const app = require('./app');
const { seedSystem } = require('./seeders/seed');
const { startIntakeJobs } = require('./modules/intake/intake.jobs');
const { startBillingJobs } = require('./modules/billing/billing.jobs');
const { startBooksJobs } = require('./modules/books/books.jobs');

async function start() {
  await connectDb();
  await seedSystem();

  app.listen(env.port, () => {
    console.log(`Sinopec API listening on http://localhost:${env.port}`);
    startIntakeJobs().catch((error) => console.error('Background jobs failed to start', error));
    startBillingJobs().catch((error) => console.error('Billing jobs failed to start', error));
    startBooksJobs().catch((error) => console.error('Books failed to start', error));
    require('./modules/task/task.hooks').startTaskReconciler();
  });
}

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
