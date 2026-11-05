const mongoose = require('mongoose');

/**
 * Singleton settings for the dropship channel (channel: 'dropship').
 * subscriptionYears is always 1 (hardcoded policy).
 */
const dropshipperSettingsSchema = new mongoose.Schema(
  {
    channel: {
      type: String,
      enum: ['dropship'],
      default: 'dropship',
      unique: true,
      required: true
    },
    subscriptionAmountInr: {
      type: Number,
      min: 0,
      default: 800,
      required: true
    },
    /** Hardcoded plan length — kept on the document for FE contract clarity. */
    subscriptionYears: {
      type: Number,
      default: 1,
      min: 1,
      max: 1
    },
    registrationOpen: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

dropshipperSettingsSchema.pre('validate', function enforceYears() {
  this.subscriptionYears = 1;
  this.channel = 'dropship';
});

dropshipperSettingsSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne({ channel: 'dropship' });
  if (!doc) {
    doc = await this.create({
      channel: 'dropship',
      subscriptionAmountInr: 800,
      subscriptionYears: 1,
      registrationOpen: true
    });
  }
  return doc;
};

dropshipperSettingsSchema.methods.toPublicSettings = function toPublicSettings() {
  return {
    channel: 'dropship',
    subscriptionAmountInr: Number(this.subscriptionAmountInr) || 800,
    subscriptionYears: 1,
    registrationOpen: this.registrationOpen !== false,
    updatedAt: this.updatedAt || null
  };
};

module.exports = mongoose.model('DropshipperSettings', dropshipperSettingsSchema);
