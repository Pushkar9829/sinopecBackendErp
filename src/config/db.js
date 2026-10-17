const dns = require('dns');
const mongoose = require('mongoose');
const env = require('./env');

// Some networks can't resolve Atlas SRV records. Set DNS_SERVERS (e.g.
// "8.8.8.8,1.1.1.1") to override; this changes DNS for the whole process, so
// it is off unless asked for.
function useSrvDns() {
  if (!String(env.mongoUri || '').startsWith('mongodb+srv://')) return;
  if (!process.env.DNS_SERVERS) return;
  const servers = String(process.env.DNS_SERVERS)
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length) dns.setServers(servers);
}

async function connectDb() {
  mongoose.set('strictQuery', true);
  // Lets inTransaction() (utils/transaction.js) put every query made inside it
  // into the transaction without passing a session around.
  mongoose.set('transactionAsyncLocalStorage', true);
  useSrvDns();
  await mongoose.connect(env.mongoUri);
}

module.exports = { connectDb };
