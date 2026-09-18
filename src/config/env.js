const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

process.env.MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
process.env.S3_BUCKET =
  process.env.S3_BUCKET || process.env.AWS_S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || '';
process.env.S3_PUBLIC_URL =
  process.env.S3_PUBLIC_URL || process.env.CLOUDFRONT_DOMAIN || process.env.AWS_CLOUDFRONT_DOMAIN || '';

const required = [
  'MONGO_URI',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'SUPERADMIN_USERNAME',
  'SUPERADMIN_PASSWORD',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const env = {
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL || '7d',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  clientOrigins: String(
    process.env.CLIENT_ORIGIN ||
      'http://localhost:5173,https://sinopecerpfrontend.vercel.app'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  superAdminUsername: process.env.SUPERADMIN_USERNAME,
  superAdminPassword: process.env.SUPERADMIN_PASSWORD,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads'),
  s3: {
    enabled: Boolean(
      process.env.AWS_ACCESS_KEY_ID &&
        process.env.AWS_SECRET_ACCESS_KEY &&
        process.env.AWS_REGION &&
        process.env.S3_BUCKET
    ),
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    region: process.env.AWS_REGION || '',
    bucket: process.env.S3_BUCKET || '',
    publicBaseUrl: process.env.S3_PUBLIC_URL || '',
  },
};

module.exports = env;
