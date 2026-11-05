const DropshipperSettings = require('../models/DropshipperSettings');

async function getSettings() {
  const doc = await DropshipperSettings.getSingleton();
  return doc;
}

async function updateSettings(patch = {}) {
  const doc = await DropshipperSettings.getSingleton();
  if (patch.subscriptionAmountInr != null) {
    const n = Number(patch.subscriptionAmountInr);
    if (!Number.isFinite(n) || n < 0) {
      const err = new Error('subscriptionAmountInr must be a non-negative number');
      err.statusCode = 400;
      err.code = 'INVALID_SUBSCRIPTION_AMOUNT';
      throw err;
    }
    doc.subscriptionAmountInr = Math.round(n * 100) / 100;
  }
  if (patch.registrationOpen != null) {
    doc.registrationOpen = Boolean(patch.registrationOpen);
  }
  // subscriptionYears always 1
  doc.subscriptionYears = 1;
  doc.channel = 'dropship';
  await doc.save();
  return doc;
}

module.exports = {
  getSettings,
  updateSettings
};
