const mongoose = require('mongoose');

/**
 * Catalog attribute master (Flipkart/Amazon-style).
 * - kind=variant → used to generate purchasable variant combinations (Color × Size)
 * - kind=spec → product-level specs only (Material, Warranty) — not variant axes
 */
const catalogAttributeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    /** Stable code used as attribute key on products/variants (e.g. color, size). */
    code: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 60,
    },
    kind: {
      type: String,
      enum: ['variant', 'spec'],
      required: true,
      index: true,
    },
    inputType: {
      type: String,
      enum: ['select', 'text', 'number'],
      default: 'select',
    },
    /** Allowed values for select-type attributes. */
    values: {
      type: [
        {
          type: String,
          trim: true,
          maxlength: 80,
        },
      ],
      default: [],
    },
    group: {
      type: String,
      trim: true,
      default: 'General',
      maxlength: 60,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 100,
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

catalogAttributeSchema.index({ kind: 1, isActive: 1, sortOrder: 1 });

module.exports = mongoose.model('CatalogAttribute', catalogAttributeSchema);
