const gmail = require('./intake.gmail');
const intakeService = require('./intake.service');

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    await gmail.pollUnread();
  } catch (error) {
    console.error('Gmail poll failed:', error.message);
  }
  try {
    await intakeService.processNext();
  } catch (error) {
    console.error('Draft reader failed:', error.message);
  } finally {
    running = false;
  }
}

function startIntakeWorker() {
  if (timer) return;
  timer = setInterval(tick, 15000);
  setTimeout(tick, 3000);
}

module.exports = { startIntakeWorker };
