/**
 * Google ID-token audiences for verifyIdToken().
 * Supports one primary client ID plus extra web/app client IDs.
 */

function uniqueNonEmpty(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const id = String(raw || '').trim();
    if (!id || id === 'NO_CLIENT_ID_SET') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function splitList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function getGoogleAudiences(env = process.env) {
  return uniqueNonEmpty([
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_WEB_CLIENT_ID,
    ...splitList(env.GOOGLE_CLIENT_IDS)
  ]);
}

/**
 * google-auth-library accepts a string or string[].
 * @param {string[]} audiences
 * @returns {string|string[]|null}
 */
function toVerifyAudience(audiences) {
  if (!Array.isArray(audiences) || audiences.length === 0) return null;
  return audiences.length === 1 ? audiences[0] : audiences;
}

module.exports = {
  uniqueNonEmpty,
  splitList,
  getGoogleAudiences,
  toVerifyAudience
};
