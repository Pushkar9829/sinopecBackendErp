const asyncHandler = require('../../utils/asyncHandler');
const analyticsService = require('./analytics.service');

const getAnalytics = asyncHandler(async (req, res) => {
  const data = await analyticsService.getAnalytics(req.user, req.query);
  res.json({ success: true, data });
});

module.exports = { getAnalytics };
