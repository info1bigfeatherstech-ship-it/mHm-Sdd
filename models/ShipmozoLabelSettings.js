const mongoose = require('mongoose');

/**
 * Per-channel custom shipping-label layout (4×6).
 * - ecomm / wholesale: standard channel configs (unchanged)
 * - dropship: independent Dropshipper label config (never mixed with ecomm)
 * Used when admin/dropshipper chooses Custom label for Shipmozo OR Shiprocket orders.
 */
const shipmozoLabelSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale', 'dropship'],
      required: true,
      unique: true,
      index: true
    },
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ShipmozoLabelSettings', shipmozoLabelSettingsSchema);
