export const COOKIE_NAME = 'kizuna_token';
export const COOKIE_REGEX = /(?:^|;\s*)kizuna_token=([^;]*)/;

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 30 * 24 * 60 * 60,
};

export const ADMIN_ROLE_ID = 'admin-role';
export const NOTIFICATIONS_ROOM = '__notifications__';

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_PINS_PER_CHANNEL = 50;
export const MAX_BACKGROUND_SIZE = 10 * 1024 * 1024;

export const BCRYPT_SALT_ROUNDS = 12;
export const TOKEN_EXPIRY = '30d';
export const PASSWORD_RESET_EXPIRY_SECONDS = 86400;

export const EMBED_FETCH_TIMEOUT_MS = 5000;
export const EMBED_CACHE_TTL_MS = 86400;

export const WEBP_QUALITY = 80;

export const RATE_LIMIT = {
  auth: { max: 120, windowMs: 60_000 },
  message: { max: 30, windowMs: 60_000 },
  upload: { max: 10, windowMs: 60_000 },
  api: { max: 60, windowMs: 60_000 },
} as const;

export const SPAM_CONFIG = {
  rateMax: 10,
  rateWindowMs: 10_000,
  channelRateMax: 8,
  channelRateWindowMs: 10_000,
  duplicateWindowMs: 30_000,
  mentionMax: 5,
  mentionWindowMs: 10_000,
  violationResetMs: 300_000,
  autoMuteDurationMs: 300_000,
  maxViolations: 5,
} as const;

export const ALLOWED_UPLOAD_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.mp4',
  '.webm',
  '.mov',
  '.pdf',
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
];
