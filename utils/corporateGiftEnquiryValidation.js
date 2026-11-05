const { normalizeIndianMobile, isValidIndianMobile } = require('./indianMobile');
const { ENQUIRY_TYPES } = require('../models/CorporateGiftEnquiry');

function trimStr(v) {
  return String(v ?? '').trim();
}

function normalizeEmail(v) {
  const e = trimStr(v).toLowerCase();
  return e || null;
}

function isValidEmail(v) {
  if (!v) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

function parsePositiveInt(v, { min = 1, max = 100000 } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function parseOptionalDate(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Validate public create payload (multipart body fields are strings).
 * @returns {{ ok: true, data: object } | { ok: false, code: string, message: string, errors?: object[] }}
 */
function validateGiftEnquiryBody(body = {}) {
  const errors = [];
  const enquiryType = trimStr(body.enquiryType || body.type).toLowerCase();

  if (!ENQUIRY_TYPES.includes(enquiryType)) {
    return {
      ok: false,
      code: 'INVALID_ENQUIRY_TYPE',
      message: 'enquiryType must be bulk or custom',
      errors: [{ field: 'enquiryType', message: 'enquiryType must be bulk or custom' }]
    };
  }

  const name = trimStr(body.name || body.fullName);
  const phone = normalizeIndianMobile(body.phone || body.mobile || body.mobileNumber);
  const emailRaw = normalizeEmail(body.email);
  const organizationName = trimStr(body.organizationName || body.companyName) || null;
  // Frontend may send state separately; DB only stores city (merge lightly).
  const cityRaw = trimStr(body.city);
  const stateRaw = trimStr(body.state);
  const city =
    cityRaw ||
    (stateRaw ? stateRaw : null) ||
    trimStr(body.cityState).split(',')[0].trim() ||
    null;

  if (!name || name.length < 2) {
    errors.push({ field: 'name', message: 'name is required' });
  }
  if (!isValidIndianMobile(phone)) {
    errors.push({ field: 'phone', message: 'Valid 10-digit Indian phone is required' });
  }
  if (emailRaw && !isValidEmail(emailRaw)) {
    errors.push({ field: 'email', message: 'Valid email is required when provided' });
  }

  const messageRaw = trimStr(body.message || body.notes || body.additionalNotes);
  let message = null;
  if (messageRaw) {
    if (messageRaw.length < 10) {
      errors.push({ field: 'message', message: 'message must be at least 10 characters when provided' });
    } else {
      message = messageRaw.slice(0, 4000);
    }
  }

  /** @type {Record<string, any>} */
  const data = {
    enquiryType,
    name: name ? name.slice(0, 120) : '',
    phone,
    email: emailRaw,
    organizationName: organizationName ? organizationName.slice(0, 200) : null,
    city: city ? city.slice(0, 120) : null,
    message,
    // type-specific defaults
    businessType: null,
    volumeOrder: null,
    occasion: null,
    giftCategory: null,
    quantity: null,
    targetDeliveryDate: null
  };

  if (enquiryType === 'bulk') {
    const businessType = trimStr(body.businessType);
    if (!businessType) {
      errors.push({ field: 'businessType', message: 'businessType is required for bulk enquiries' });
    } else {
      data.businessType = businessType.slice(0, 120);
    }

    if (
      body.volumeOrder !== undefined &&
      body.volumeOrder !== null &&
      String(body.volumeOrder).trim() !== ''
    ) {
      const volumeOrder = parsePositiveInt(body.volumeOrder);
      if (volumeOrder == null) {
        errors.push({
          field: 'volumeOrder',
          message: 'volumeOrder must be an integer between 1 and 100000'
        });
      } else {
        data.volumeOrder = volumeOrder;
      }
    }
  }

  if (enquiryType === 'custom') {
    const occasion = trimStr(body.occasion);
    const giftCategory = trimStr(body.giftCategory || body.category);
    const quantity = parsePositiveInt(body.quantity);

    if (!occasion) {
      errors.push({ field: 'occasion', message: 'occasion is required for custom enquiries' });
    } else {
      data.occasion = occasion.slice(0, 120);
    }

    if (!giftCategory) {
      errors.push({ field: 'giftCategory', message: 'giftCategory is required for custom enquiries' });
    } else {
      data.giftCategory = giftCategory.slice(0, 120);
    }

    if (quantity == null) {
      errors.push({
        field: 'quantity',
        message: 'quantity is required and must be an integer between 1 and 100000'
      });
    } else {
      data.quantity = quantity;
    }

    if (!data.city) {
      errors.push({ field: 'city', message: 'city is required for custom enquiries' });
    }

    if (
      body.targetDeliveryDate !== undefined &&
      body.targetDeliveryDate !== null &&
      String(body.targetDeliveryDate).trim() !== ''
    ) {
      const targetDeliveryDate = parseOptionalDate(body.targetDeliveryDate);
      if (!targetDeliveryDate) {
        errors.push({ field: 'targetDeliveryDate', message: 'targetDeliveryDate must be a valid date' });
      } else {
        data.targetDeliveryDate = targetDeliveryDate;
      }
    }
  }

  if (errors.length) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: errors[0]?.message || 'Validation failed',
      errors
    };
  }

  return { ok: true, data };
}

/**
 * Validate which file fields are allowed for the enquiry type.
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function validateGiftEnquiryFilesForType(enquiryType, files = {}) {
  const bag = files || {};
  const logos = Array.isArray(bag.logos) ? bag.logos : [];
  const referencePhotos = Array.isArray(bag.referencePhotos) ? bag.referencePhotos : [];
  const businessCards = Array.isArray(bag.businessCard)
    ? bag.businessCard
    : bag.businessCard
      ? [bag.businessCard]
      : [];

  if (enquiryType === 'bulk') {
    if (logos.length || referencePhotos.length) {
      return {
        ok: false,
        code: 'FILES_NOT_ALLOWED',
        message: 'logos and referencePhotos are not allowed on bulk enquiries'
      };
    }
    if (businessCards.length > 1) {
      return {
        ok: false,
        code: 'TOO_MANY_FILES',
        message: 'Only one businessCard file is allowed'
      };
    }
  }

  if (enquiryType === 'custom') {
    if (businessCards.length) {
      return {
        ok: false,
        code: 'FILES_NOT_ALLOWED',
        message: 'businessCard is not allowed on custom enquiries'
      };
    }
    if (logos.length > 3) {
      return {
        ok: false,
        code: 'TOO_MANY_FILES',
        message: 'Maximum 3 logo files are allowed'
      };
    }
    if (referencePhotos.length > 6) {
      return {
        ok: false,
        code: 'TOO_MANY_FILES',
        message: 'Maximum 6 reference photos are allowed'
      };
    }
  }

  return { ok: true };
}

const ADMIN_STATUSES = ['pending', 'contacted', 'quoted', 'closed', 'converted'];

function validateStatusUpdateBody(body = {}) {
  const status = trimStr(body.status).toLowerCase();
  if (!ADMIN_STATUSES.includes(status)) {
    return {
      ok: false,
      code: 'INVALID_STATUS',
      message: `status must be one of: ${ADMIN_STATUSES.join(', ')}`
    };
  }
  const adminNoteRaw = body.adminNote;
  const adminNote =
    adminNoteRaw == null ? undefined : trimStr(adminNoteRaw).slice(0, 2000) || null;
  const convertedOrderIdRaw = body.convertedOrderId;
  const convertedOrderId =
    convertedOrderIdRaw == null
      ? undefined
      : trimStr(convertedOrderIdRaw).slice(0, 64) || null;

  if (status === 'converted' && convertedOrderId === null && convertedOrderIdRaw != null) {
    return {
      ok: false,
      code: 'INVALID_CONVERTED_ORDER_ID',
      message: 'convertedOrderId cannot be empty when provided'
    };
  }

  return {
    ok: true,
    data: { status, adminNote, convertedOrderId }
  };
}

module.exports = {
  validateGiftEnquiryBody,
  validateGiftEnquiryFilesForType,
  validateStatusUpdateBody,
  ADMIN_STATUSES
};
