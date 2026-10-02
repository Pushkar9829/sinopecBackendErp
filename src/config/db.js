const dns = require('dns');
const mongoose = require('mongoose');
const env = require('./env');

function useSrvDns() {
  if (!String(env.mongoUri || '').startsWith('mongodb+srv://')) return;
  const servers = String(process.env.DNS_SERVERS || '8.8.8.8,1.1.1.1')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length) dns.setServers(servers);
}

async function connectDb() {
  mongoose.set('strictQuery', true);
  useSrvDns();
  await mongoose.connect(env.mongoUri);
}

module.exports = { connectDb };
