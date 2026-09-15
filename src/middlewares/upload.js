const fs = require('fs');
const path = require('path');
const multer = require('multer');
const env = require('../config/env');

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(env.uploadsDir, 'sales-orders', String(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').slice(0, 12);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
});

module.exports = upload;
