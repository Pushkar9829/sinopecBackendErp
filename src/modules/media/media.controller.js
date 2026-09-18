const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const { uploadBuffer, isS3Enabled } = require('../../utils/storage');

const ALLOWED_FOLDERS = new Set(['products', 'sales-orders', 'artwork', 'misc']);

const upload = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, 'File is required');
  }

  const folder = String(req.body.folder || req.query.folder || 'misc').trim();
  if (!ALLOWED_FOLDERS.has(folder)) {
    throw new ApiError(400, 'Invalid upload folder');
  }

  const uploaded = await uploadBuffer({
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    folder,
  });

  res.status(201).json({
    success: true,
    data: {
      ...uploaded,
      storageMode: isS3Enabled() ? 's3' : 'local',
    },
  });
});

module.exports = { upload };
