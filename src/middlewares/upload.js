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

// Files are held in memory until stored, so cap both each file and the whole
// request: a 5-file intake read could otherwise hold 75 MB per request.
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_REQUEST_BYTES = 25 * 1024 * 1024;

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 10, fields: 50, fieldSize: 1024 * 1024 },
  fileFilter(req, file, callback) {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    if (BLOCKED_MIME.test(file.mimetype || '') || !(IMAGE_EXT.has(ext) || DOC_EXT.has(ext))) {
      return callback(new ApiError(400, 'This file type is not allowed. Use an image, PDF, artwork, office, text, or zip file.'));
    }
    return callback(null, true);
  },
});

function requestSizeGuard(req, res, next) {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    return next(new ApiError(413, `Upload is too large. Keep the files under ${MAX_REQUEST_BYTES / 1024 / 1024} MB in total.`));
  }
  return next();
}

function guarded(middleware) {
  return (req, res, next) => requestSizeGuard(req, res, (error) => (error ? next(error) : middleware(req, res, next)));
}

const upload = {
  single: (...args) => guarded(multerUpload.single(...args)),
  array: (...args) => guarded(multerUpload.array(...args)),
  fields: (...args) => guarded(multerUpload.fields(...args)),
  none: (...args) => guarded(multerUpload.none(...args)),
};

upload.MAX_REQUEST_BYTES = MAX_REQUEST_BYTES;
upload.isImageFile = isImageFile;
upload.IMAGE_EXT = IMAGE_EXT;

module.exports = upload;
