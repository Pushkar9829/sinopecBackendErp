const env = require('./config/env');
const { connectDb } = require('./config/db');
const app = require('./app');
const { seedSystem } = require('./seeders/seed');

async function start() {
  await connectDb();
  await seedSystem();

  app.listen(env.port, () => {
    console.log(`Sinopec API listening on http://localhost:${env.port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
