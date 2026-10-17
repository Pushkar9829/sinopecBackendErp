const { ROLE_SLUGS, TASK_CATEGORIES, TASK_OPEN_STATUSES, TASK_STATUSES } = require('../../config/constants');
const { nextTaskNumber } = require('../../utils/counter');
const Task = require('../task/task.model');

// One open "review this draft order" task per draft, for the Super Admin.
// It closes itself when the draft is converted, discarded or marked not an order.
function keyOf(intake) {
  return `intake:${intake._id}:review`;
}

function senderLabel(intake) {
  return intake.customerName || intake.sender?.name || intake.sender?.email || intake.sender?.phone || intake.channel;
}

async function ensureReviewTask(intake, slaHours = 4) {
  const key = keyOf(intake);
  if (await Task.exists({ openKey: key })) return;
  try {
    await Task.create({
      number: await nextTaskNumber(),
      title: `Review draft order ${intake.number} from ${senderLabel(intake)}`,
      description: 'Check the customer and lines the reader found, then convert it to a draft sales order or discard it.',
      category: TASK_CATEGORIES.INTAKE_REVIEW,
      source: 'auto',
      autoKey: key,
      openKey: key,
      intake: intake._id,
      intakeNumber: intake.number,
      assigneeRole: ROLE_SLUGS.SUPER_ADMIN,
      dueDate: intake.reviewDueAt || new Date(Date.now() + slaHours * 60 * 60 * 1000),
      history: [{ from: '', to: TASK_STATUSES.OPEN, byName: 'System', note: 'Created automatically' }],
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}

async function closeReviewTask(intake, status, actor, note) {
  const tasks = await Task.find({ intake: intake._id, category: TASK_CATEGORIES.INTAKE_REVIEW, status: { $in: TASK_OPEN_STATUSES } });
  for (const task of tasks) {
    task.history.push({
      from: task.status,
      to: status,
      by: actor?._id || null,
      byName: actor?.fullName || actor?.username || 'System',
      note,
    });
    task.status = status;
    task.openKey = undefined;
    task.completedAt = new Date();
    if (status === TASK_STATUSES.DONE) {
      task.completedBy = actor?._id || null;
      task.completedByName = actor?.fullName || actor?.username || '';
    }
    await task.save();
  }
}

// Never throws: a task problem must not block the draft action.
async function safely(work) {
  try {
    await work();
  } catch (error) {
    console.error('Draft review task update failed:', error.message);
  }
}

module.exports = {
  ensureReviewTask: (intake, slaHours) => safely(() => ensureReviewTask(intake, slaHours)),
  closeReviewTask: (intake, status, actor, note) => safely(() => closeReviewTask(intake, status, actor, note)),
};
