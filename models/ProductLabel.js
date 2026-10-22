const mongoose = require('mongoose');

/**
 * Admin-configurable marketing labels (e.g. On Sale, Today's Deal, Rakhi's Sale).
 * Product membership lives on ProductTag.tags[] using this document's `slug`.
 */
const productLabelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    /** Canonical key stored on ProductTag.tags and used in ?tags= filters. */
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 80,
      index: true,
    },

    /**
     * Storefront path opened when the label is clicked
     * (e.g. /on-sale, /TagProducts/rakhis-sale).
     */
    pagePath: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    /** When false, label still works for filtering but is hidden from public nav. */
    showInNav: {
      type: Boolean,
      default: true,
    },

    /**
     * When true (and isActive), render this label as a product section on the homepage.
     * Independent of showInNav — nav and homepage can be configured separately.
     */
    showOnHomepage: {
      type: Boolean,
      default: false,
      index: true,
    },

    /** Sort order for homepage sections only (lower first). */
    homepageSortOrder: {
      type: Number,
      default: 100,
    },

    /** Max products to show in the homepage section for this label (1–48). */
    homepageLimit: {
      type: Number,
      default: 10,
      min: 1,
      max: 48,
    },

    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },

    storefronts: {
      type: [
        {
          type: String,
          enum: ['ecomm', 'wholesale'],
        },
      ],
      default: ['ecomm', 'wholesale'],
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.length > 0;
        },
        message: 'At least one storefront is required',
      },
    },

    /** Seeded legacy labels (on-sale, today-arrival). Still editable/deletable. */
    isSystem: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

productLabelSchema.index({ isActive: 1, sortOrder: 1, name: 1 });
productLabelSchema.index({ storefronts: 1, isActive: 1, showInNav: 1 });
productLabelSchema.index({ storefronts: 1, isActive: 1, showOnHomepage: 1, homepageSortOrder: 1 });

module.exports = mongoose.model('ProductLabel', productLabelSchema);
