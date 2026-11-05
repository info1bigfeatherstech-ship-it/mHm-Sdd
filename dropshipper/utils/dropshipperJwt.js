const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_EXPIRES = process.env.DROPSHIPPER_ACCESS_TOKEN_EXPIRES || '7d';
const REFRESH_EXPIRES = process.env.DROPSHIPPER_REFRESH_TOKEN_EXPIRES || '30d';

function getAccessSecret() {
  return String(process.env.JWT_SECRET || '').trim();
}

function getRefreshSecret() {
  return String(process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || '').trim();
}

/**
 * Dropshipper access JWT claims:
 * { id, type: 'access', role: 'dropshipper', portal: 'dropshipper', channel: 'dropship' }
 */
function signDropshipperAccessToken(dropshipperId) {
  return jwt.sign(
    {
      id: String(dropshipperId),
      type: 'access',
      role: 'dropshipper',
      portal: 'dropshipper',
      channel: 'dropship'
    },
    getAccessSecret(),
    { expiresIn: ACCESS_EXPIRES }
  );
}

function signDropshipperRefreshToken(dropshipperId) {
  return jwt.sign(
    {
      id: String(dropshipperId),
      type: 'refresh',
      role: 'dropshipper',
      portal: 'dropshipper',
      channel: 'dropship',
      jti: crypto.randomUUID()
    },
    getRefreshSecret(),
    { expiresIn: REFRESH_EXPIRES }
  );
}

function verifyDropshipperAccessToken(token) {
  const decoded = jwt.verify(token, getAccessSecret());
  if (decoded.type !== 'access') {
    const err = new Error('Invalid token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  if (String(decoded.role || '') !== 'dropshipper' || String(decoded.portal || '') !== 'dropshipper') {
    const err = new Error('Not a dropshipper token');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return decoded;
}

function verifyDropshipperRefreshToken(token) {
  const decoded = jwt.verify(token, getRefreshSecret());
  if (decoded.type !== 'refresh') {
    const err = new Error('Invalid token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  if (String(decoded.role || '') !== 'dropshipper') {
    const err = new Error('Not a dropshipper refresh token');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return decoded;
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseExpiryToSeconds(expiresIn) {
  const raw = String(expiresIn || '15m').trim();
  const m = raw.match(/^(\d+)([smhd])$/i);
  if (!m) return 15 * 60;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  if (unit === 'd') return n * 86400;
  return 15 * 60;
}

function getAccessTtlSeconds() {
  return parseExpiryToSeconds(ACCESS_EXPIRES);
}

function getRefreshExpiryDate() {
  const seconds = parseExpiryToSeconds(REFRESH_EXPIRES);
  return new Date(Date.now() + seconds * 1000);
}

module.exports = {
  ACCESS_EXPIRES,
  REFRESH_EXPIRES,
  signDropshipperAccessToken,
  signDropshipperRefreshToken,
  verifyDropshipperAccessToken,
  verifyDropshipperRefreshToken,
  hashRefreshToken,
  getAccessTtlSeconds,
  getRefreshExpiryDate
};
