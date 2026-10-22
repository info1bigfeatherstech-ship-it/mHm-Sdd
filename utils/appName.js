/**
 * Public brand / store display name from APP_NAME env.
 * Use everywhere user-facing copy needs the product name
 * (emails, OTP, push, SEO, invoices, shipping labels, exports).
 */

function getAppName() {
  const name = String(process.env.APP_NAME || '').trim();
  return name || 'App';
}

/** Alphanumeric token for User-Agent / workbook metadata. */
function getAppNameToken() {
  const token = getAppName().replace(/[^a-zA-Z0-9]+/g, '');
  return token || 'App';
}

module.exports = { getAppName, getAppNameToken };
