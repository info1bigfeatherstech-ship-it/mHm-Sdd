const mongoose = require('mongoose');
const { SHIPPING_PROVIDERS } = require('../constants/shippingProviders');

/**
 * Per-storefront shipping-partner settings.
 * activeProvider applies only to NEW checkout / place-order on that storefront.
 * Existing orders keep order.shippingProvider forever.
 */
const shippingProviderSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      required: true,
      unique: true,
      index: true
    },
    /** @deprecated singleton leftover — no longer unique */
    key: {
      type: String,
      default: null,
      trim: true
    },
    activeProvider: {
      type: String,
      enum: Object.values(SHIPPING_PROVIDERS),
      default: SHIPPING_PROVIDERS.SHIPROCKET,
      required: true
    },
    shipmozo: {
      enabled: { type: Boolean, default: true },
      publicKey: { type: String, default: null, trim: true },
      privateKey: { type: String, default: null, trim: true },
      warehouseId: { type: String, default: null, trim: true },
      pickupPincode: { type: String, default: null, trim: true },
      warehouseAddressTitle: { type: String, default: null, trim: true }
    },
    /**
     * Standard courier checkout (Shiprocket / Shipmozo active provider).
     * Default ON so existing stores keep current behaviour. When OFF, checkout
     * may only confirm Same Day — no silent fallback to a standard courier.
     */
    standardDelivery: {
      enabled: { type: Boolean, default: true }
    },
    /**
     * Same Day (Shiprocket Quick) — checkout option. Default OFF.
     * Becomes the only checkout option when standardDelivery.enabled is false.
     */
    sameDay: {
      enabled: { type: Boolean, default: false },
      pincodes: { type: [String], default: [] },
      openHour: { type: Number, default: 9, min: 0, max: 23 },
      cutoffHour: { type: Number, default: 14, min: 0, max: 23 },
      floorFeeInr: { type: Number, default: 0, min: 0, max: 9999 },
      feeBuffer: { type: Number, default: 1.2, min: 1, max: 2 },
      warehouseLat: { type: Number, default: null },
      warehouseLng: { type: Number, default: null }
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ShippingProviderSettings', shippingProviderSettingsSchema);
