const path = require('path');
const multer = require('multer');
const ApiError = require('../utils/ApiError');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const DOC_EXT = new Set([
  '.pdf',
  '.ai',
  '.eps',
  '.psd',
  '.cdr',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
  '.zip',
]);
const BLOCKED_MIME = /(html|svg|javascript|xml|x-sh|x-msdownload)/i;

function isImageFile(name, mime) {
  return IMAGE_EXT.has(path.extname(String(name || '')).toLowerCase()) && String(mime || '').startsWith('image/');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    if (BLOCKED_MIME.test(file.mimetype || '') || !(IMAGE_EXT.has(ext) || DOC_EXT.has(ext))) {
      return callback(new ApiError(400, 'This file type is not allowed. Use an image, PDF, artwork, office, text, or zip file.'));
    }
    return callback(null, true);
  },
});

upload.isImageFile = isImageFile;
upload.IMAGE_EXT = IMAGE_EXT;

module.exports = upload;
