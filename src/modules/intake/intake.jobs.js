const jobs = require('../../utils/jobQueue');
const service = require('./intake.service');
const gmail = require('./intake.gmail');
const whatsapp = require('./intake.whatsapp');
const replies = require('./intake.replies');

const MINUTE = 60 * 1000;

function registerIntakeJobs() {
  jobs.register('gmail:sync', () => gmail.sync());
  jobs.register('gmail:message', (payload) => gmail.fetchMessage(payload), { concurrency: 2 });
  jobs.register('whatsapp:message', (payload) => whatsapp.ingestMessage(payload), { concurrency: 3 });
  jobs.register('intake:read', (payload, job) => service.runRead(payload, job), { concurrency: 2 });
  jobs.register('intake:reply', (payload) => replies.sendReply(payload));
  jobs.register('intake:mark-source', (payload) => service.markSource(payload));
  jobs.register('intake:retention', () => service.removeOldBodies());
}

async function startIntakeJobs() {
  registerIntakeJobs();
  await jobs.ensureRecurring('gmail:sync', MINUTE);
  await jobs.ensureRecurring('intake:retention', 6 * 60 * MINUTE);
  const recovered = await service.recoverStuck();
  if (recovered) console.log(`Queued ${recovered} draft order(s) left unread before the restart`);
  jobs.start(2000);
}

module.exports = { registerIntakeJobs, startIntakeJobs };
