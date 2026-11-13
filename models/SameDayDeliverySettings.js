const mongoose = require('mongoose');

/**
 * Ecomm-only same-day delivery pincode allowlist (manual warehouse — no courier).
 * Separate collection — does not touch shipping provider settings.
 */
const sameDayDeliverySettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm'],
      required: true,
      unique: true,
      default: 'ecomm'
    },
    enabled: { type: Boolean, default: false },
    pincodes: {
      type: [String],
      default: []
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SameDayDeliverySettings', sameDayDeliverySettingsSchema);
