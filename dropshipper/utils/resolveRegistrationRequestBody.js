/**
 * Multipart + JSON body normalization for registration create-payment.
 * Field values may arrive as strings (multipart) or nested JSON.
 */

function tryParseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  const s = String(value).trim();
  if (!s) return null;
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Flatten applicant fields from req.body, accepting optional nested `applicant` / `payload` JSON.
 */
function resolveRegistrationRequestBody(req) {
  const body = req?.body && typeof req.body === 'object' ? { ...req.body } : {};
  const nested =
    tryParseJson(body.applicant) ||
    tryParseJson(body.payload) ||
    tryParseJson(body.data) ||
    (body.applicant && typeof body.applicant === 'object' ? body.applicant : null) ||
    (body.payload && typeof body.payload === 'object' ? body.payload : null);

  if (nested && typeof nested === 'object') {
    return { ...nested, ...body, applicant: undefined, payload: undefined, data: undefined };
  }
  return body;
}

module.exports = {
  tryParseJson,
  resolveRegistrationRequestBody
};
