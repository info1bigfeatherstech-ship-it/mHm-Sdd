const mongoose = require('mongoose');

const dropshipperRegistrationRequestSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['registration', 'renewal'],
      default: 'registration',
      index: true
    },
    adminStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'created', 'paid', 'failed'],
      default: 'pending',
      index: true
    },

    fullName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    businessName: { type: String, trim: true, default: null },
    whatsappNumber: { type: String, trim: true, default: null },
    permanentAddress: { type: String, required: true, trim: true },
    haveShop: { type: Boolean, default: false },
    businessAddress: { type: String, trim: true, default: null },
    deliveryAddress: { type: String, trim: true, default: null },
    sellingPlaceFrom: { type: String, trim: true, default: null },
    sellingZoneCity: { type: String, trim: true, default: null },
    productCategory: { type: String, trim: true, default: null },
    monthlyEstimatedPurchase: { type: Number, min: 0, default: null },

    idProofUrl: { type: String, default: null },
    idProofPublicId: { type: String, default: null },
    businessAddressProofUrl: { type: String, default: null },
    businessAddressProofPublicId: { type: String, default: null },

    subscriptionAmountInr: { type: Number, required: true, min: 0 },
    subscriptionYears: { type: Number, default: 1, min: 1, max: 1 },

    razorpayOrderId: { type: String, default: null, index: true },
    razorpayPaymentId: { type: String, default: null },
    razorpaySignature: { type: String, default: null },
    paidAt: { type: Date, default: null },
    paymentMeta: { type: mongoose.Schema.Types.Mixed, default: null },

    adminNote: { type: String, default: null, trim: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },

    /** Linked Dropshipper created on approve (registration) or renewed account (renewal). */
    dropshipperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dropshipper',
      default: null,
      index: true
    }
  },
  { timestamps: true }
);

dropshipperRegistrationRequestSchema.index({ adminStatus: 1, kind: 1, createdAt: -1 });
dropshipperRegistrationRequestSchema.index({ email: 1, kind: 1, createdAt: -1 });
dropshipperRegistrationRequestSchema.index({ phone: 1, kind: 1, createdAt: -1 });

module.exports = mongoose.model(
  'DropshipperRegistrationRequest',
  dropshipperRegistrationRequestSchema
);
