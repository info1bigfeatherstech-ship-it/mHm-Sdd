const mongoose = require('mongoose');

const ENQUIRY_TYPES = ['bulk', 'custom'];
const STATUS_ENUM = ['pending', 'contacted', 'quoted', 'closed', 'converted'];
const OPEN_STATUSES = ['pending', 'contacted', 'quoted'];
const STOREFRONTS = ['ecomm', 'wholesale'];

const mediaAssetSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    publicId: { type: String, default: null, trim: true },
    originalName: { type: String, default: null, trim: true },
    mimeType: { type: String, default: null, trim: true },
    sizeBytes: { type: Number, default: null, min: 0 },
    kind: {
      type: String,
      enum: ['logo', 'reference', 'business_card'],
      required: true
    }
  },
  { _id: false }
);

const corporateGiftEnquirySchema = new mongoose.Schema(
  {
    enquiryType: {
      type: String,
      enum: ENQUIRY_TYPES,
      required: true,
      index: true
    },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
      maxlength: 254,
      index: true
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    organizationName: { type: String, trim: true, default: null, maxlength: 200 },
    city: { type: String, trim: true, default: null, maxlength: 120 },

    // Custom-heavy
    occasion: { type: String, trim: true, default: null, maxlength: 120 },
    giftCategory: { type: String, trim: true, default: null, maxlength: 120 },
    quantity: { type: Number, default: null, min: 1, max: 100000 },
    targetDeliveryDate: { type: Date, default: null },
    message: { type: String, trim: true, default: null, maxlength: 4000 },

    // Bulk-heavy
    businessType: { type: String, trim: true, default: null, maxlength: 120 },
    volumeOrder: { type: Number, default: null, min: 1, max: 100000 },

    logos: { type: [mediaAssetSchema], default: [] },
    referencePhotos: { type: [mediaAssetSchema], default: [] },
    businessCard: { type: mediaAssetSchema, default: null },

    storefront: {
      type: String,
      enum: STOREFRONTS,
      default: 'ecomm',
      index: true
    },
    source: {
      type: String,
      enum: ['gift_page'],
      default: 'gift_page'
    },

    status: {
      type: String,
      enum: STATUS_ENUM,
      default: 'pending',
      index: true
    },
    adminNote: { type: String, trim: true, default: null, maxlength: 2000 },
    convertedOrderId: { type: String, trim: true, default: null, maxlength: 64 },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },

    contactedAt: { type: Date, default: null },
    quotedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    convertedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

corporateGiftEnquirySchema.index({
  phone: 1,
  enquiryType: 1,
  storefront: 1,
  status: 1,
  createdAt: -1
});
corporateGiftEnquirySchema.index({ storefront: 1, enquiryType: 1, createdAt: -1 });
corporateGiftEnquirySchema.index({ storefront: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('CorporateGiftEnquiry', corporateGiftEnquirySchema);
module.exports.ENQUIRY_TYPES = ENQUIRY_TYPES;
module.exports.STATUS_ENUM = STATUS_ENUM;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
module.exports.STOREFRONTS = STOREFRONTS;
