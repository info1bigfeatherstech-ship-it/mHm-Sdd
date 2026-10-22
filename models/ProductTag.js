const mongoose = require('mongoose');

/**
 * Per-product marketing tag membership.
 * `tags` values are ProductLabel.slug strings (e.g. on-sale, today-arrival, rakhis-sale).
 * Enum removed so admin-defined labels work without schema deploys.
 */
const productTagSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },

    tags: {
      type: [String],
      default: [],
      validate: {
        validator(arr) {
          if (!Array.isArray(arr)) return false;
          // Keep entries clean; empty array OK
          return arr.every(
            (t) => typeof t === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t)
          );
        },
        message: 'Each tag must be a kebab-case slug',
      },
    },
  },
  { timestamps: true }
);

productTagSchema.index({ product: 1 }, { unique: true });
productTagSchema.index({ tags: 1 });

module.exports = mongoose.model('ProductTag', productTagSchema);
