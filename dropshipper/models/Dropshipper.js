const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const applicationSnapshotSchema = new mongoose.Schema(
  {
    permanentAddress: { type: String, default: null },
    haveShop: { type: Boolean, default: false },
    businessAddress: { type: String, default: null },
    deliveryAddress: { type: String, default: null },
    sellingPlaceFrom: { type: String, default: null },
    sellingZoneCity: { type: String, default: null },
    productCategory: { type: String, default: null },
    monthlyEstimatedPurchase: { type: Number, default: null },
    idProofUrl: { type: String, default: null },
    businessAddressProofUrl: { type: String, default: null }
  },
  { _id: false }
);

const subscriptionSchema = new mongoose.Schema(
  {
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    amountPaidInr: { type: Number, default: null },
    planYears: { type: Number, default: 1 },
    renewedAt: { type: Date, default: null }
  },
  { _id: false }
);

const refreshTokenEntrySchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const dropshipperSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true
    },
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    businessName: { type: String, trim: true, default: null },
    whatsappNumber: { type: String, trim: true, default: null },

    passwordHash: {
      type: String,
      select: false,
      default: null
    },

    status: {
      type: String,
      enum: [
        'pending_payment',
        'pending_admin',
        'pending_otp',
        'active',
        'expired',
        'suspended',
        'rejected'
      ],
      default: 'pending_otp',
      index: true
    },

    channel: {
      type: String,
      enum: ['dropship'],
      default: 'dropship'
    },

    subscription: {
      type: subscriptionSchema,
      default: () => ({})
    },

    application: {
      type: applicationSnapshotSchema,
      default: () => ({})
    },

    otpHash: { type: String, select: false, default: null },
    otpExpiresAt: { type: Date, default: null },
    otpAttempts: { type: Number, default: 0 },
    otpSentAt: { type: Date, default: null },

    lastLoginAt: { type: Date, default: null },
    passwordSetAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionNote: { type: String, default: null },

    registrationRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DropshipperRegistrationRequest',
      default: null
    },

    refreshTokens: {
      type: [refreshTokenEntrySchema],
      select: false,
      default: []
    }
  },
  { timestamps: true }
);

dropshipperSchema.methods.setPassword = async function setPassword(plain) {
  const salt = await bcrypt.genSalt(12);
  this.passwordHash = await bcrypt.hash(String(plain), salt);
  this.passwordSetAt = new Date();
};

dropshipperSchema.methods.comparePassword = async function comparePassword(plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(String(plain || ''), this.passwordHash);
};

dropshipperSchema.methods.hasActiveSubscription = function hasActiveSubscription(now = new Date()) {
  if (this.status !== 'active') return false;
  const endsAt = this.subscription?.endsAt ? new Date(this.subscription.endsAt) : null;
  if (!endsAt || Number.isNaN(endsAt.getTime())) return false;
  return endsAt.getTime() > now.getTime();
};

dropshipperSchema.methods.toSafeJSON = function toSafeJSON() {
  const endsAt = this.subscription?.endsAt ? new Date(this.subscription.endsAt) : null;
  const now = Date.now();
  const isExpired = endsAt ? endsAt.getTime() <= now : true;
  const daysRemaining =
    endsAt && !isExpired
      ? Math.max(0, Math.ceil((endsAt.getTime() - now) / (24 * 60 * 60 * 1000)))
      : 0;

  return {
    _id: this._id,
    id: String(this._id),
    fullName: this.fullName,
    email: this.email,
    phone: this.phone,
    businessName: this.businessName || null,
    whatsappNumber: this.whatsappNumber || null,
    status: this.status,
    channel: this.channel || 'dropship',
    subscription: {
      amountPaidInr: this.subscription?.amountPaidInr ?? null,
      startsAt: this.subscription?.startsAt || null,
      endsAt: this.subscription?.endsAt || null,
      daysRemaining,
      planYears: this.subscription?.planYears || 1,
      renewedAt: this.subscription?.renewedAt || null,
      isExpired,
      active: this.hasActiveSubscription()
    },
    application: this.application || {},
    hasPassword: Boolean(this.passwordSetAt),
    registrationRequestId: this.registrationRequestId || null,
    approvedAt: this.approvedAt || null,
    rejectedAt: this.rejectedAt || null,
    rejectionNote: this.rejectionNote || null,
    lastLoginAt: this.lastLoginAt || null,
    passwordSetAt: this.passwordSetAt || null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('Dropshipper', dropshipperSchema);
