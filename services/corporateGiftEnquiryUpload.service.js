/**
 * Gift enquiry media upload + rollback.
 * Uses default media provider (R2 / Cloudinary) via cloudinaryHelper + r2Storage.
 */
const path = require('path');
const {
  uploadToCloudinary,
  deleteFromCloudinary,
  optimizeProductImageBuffer
} = require('../utils/cloudinaryHelper');
const { uploadBufferToR2 } = require('../utils/r2Storage');
const { assertGiftEnquiryFileAllowed } = require('../utils/giftEnquiryFileSignature');
const logger = require('../utils/logger');

const MAX_FILE_BYTES = 20 * 1024 * 1024;

function mediaConfigured() {
  const mode = String(process.env.MEDIA_STORAGE_MODE || '').trim().toLowerCase();
  const provider = String(process.env.MEDIA_PROVIDER_DEFAULT || '').trim().toLowerCase();
  const r2Ready =
    Boolean(String(process.env.R2_ACCOUNT_ID || '').trim()) &&
    Boolean(String(process.env.R2_ACCESS_KEY_ID || '').trim()) &&
    Boolean(String(process.env.R2_SECRET_ACCESS_KEY || '').trim()) &&
    Boolean(String(process.env.R2_BUCKET_NAME || process.env.R2_BUCKET || '').trim());
  const cloudinaryReady =
    Boolean(String(process.env.CLOUDINARY_CLOUD_NAME || '').trim()) &&
    Boolean(String(process.env.CLOUDINARY_API_KEY || '').trim()) &&
    Boolean(String(process.env.CLOUDINARY_API_SECRET || '').trim());

  if (provider === 'r2' || mode === 'hybrid' || mode === 'r2') return r2Ready;
  if (provider === 'cloudinary' || mode === 'cloudinary') return cloudinaryReady;
  return r2Ready || cloudinaryReady;
}

function sanitizePublicIdPart(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'file'
  );
}

function getDefaultProvider() {
  const mode = String(process.env.MEDIA_STORAGE_MODE || '').trim().toLowerCase();
  const explicit = String(process.env.MEDIA_PROVIDER_DEFAULT || '').trim().toLowerCase();
  if (explicit === 'r2' || explicit === 'cloudinary') return explicit;
  if (mode === 'hybrid' || mode === 'r2') return 'r2';
  return 'cloudinary';
}

async function uploadPdfBuffer(buffer, folderPath, publicIdName) {
  const provider = getDefaultProvider();
  if (provider === 'r2') {
    const upload = await uploadBufferToR2({
      buffer,
      folderPath,
      publicIdName,
      contentType: 'application/pdf',
      extension: 'pdf',
      cacheControl: 'public, max-age=31536000, immutable'
    });
    return { url: upload.url, publicId: `r2:${upload.key}` };
  }

  // Cloudinary: upload PDF as raw
  const { cloudinary } = require('../config/cloudinary.config');
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: folderPath,
        public_id: publicIdName,
        resource_type: 'raw',
        format: 'pdf'
      },
      (error, result) => {
        if (error) reject(new Error(`Cloudinary PDF upload error: ${error.message}`));
        else resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

async function uploadOneFile(file, { folder, kind, allowPdf, allowImage }) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    const err = new Error('Invalid upload file');
    err.code = 'INVALID_UPLOAD';
    err.statusCode = 400;
    throw err;
  }
  if (file.buffer.length > MAX_FILE_BYTES) {
    const err = new Error('File exceeds maximum size of 20MB');
    err.code = 'FILE_TOO_LARGE';
    err.statusCode = 400;
    throw err;
  }

  const signature = assertGiftEnquiryFileAllowed(file.buffer, { allowPdf, allowImage });
  if (!signature.ok) {
    const err = new Error(signature.message);
    err.code = signature.code;
    err.statusCode = 400;
    throw err;
  }

  const baseName = sanitizePublicIdPart(
    path.parse(String(file.originalname || 'upload')).name || kind
  );
  const publicIdName = `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let uploaded;
  let mimeType = signature.detectedMime;
  let sizeBytes = file.buffer.length;

  if (signature.kind === 'pdf') {
    uploaded = await uploadPdfBuffer(file.buffer, folder, publicIdName);
  } else {
    const optimized = await optimizeProductImageBuffer(file.buffer);
    sizeBytes = optimized.length;
    mimeType = 'image/webp';
    uploaded = await uploadToCloudinary(optimized, folder, publicIdName);
  }

  return {
    url: uploaded.url,
    publicId: uploaded.publicId,
    originalName: String(file.originalname || '').slice(0, 200) || null,
    mimeType,
    sizeBytes,
    kind
  };
}

async function rollbackAssets(assets = []) {
  for (const asset of assets) {
    if (!asset?.publicId) continue;
    try {
      await deleteFromCloudinary(asset.publicId);
    } catch (err) {
      logger.warn('[gift-enquiry] rollback delete failed', {
        publicId: asset.publicId,
        message: err?.message || String(err)
      });
    }
  }
}

/**
 * Upload files for a validated enquiry type.
 * @returns {Promise<{ logos: object[], referencePhotos: object[], businessCard: object|null, uploaded: object[] }>}
 */
async function uploadGiftEnquiryFiles(enquiryType, files = {}) {
  if (!mediaConfigured()) {
    const err = new Error(
      'Media storage is not configured. Set MEDIA_STORAGE_MODE / R2 or Cloudinary credentials.'
    );
    err.code = 'MEDIA_STORAGE_UNAVAILABLE';
    err.statusCode = 503;
    throw err;
  }

  const bag = files || {};
  const logosIn = Array.isArray(bag.logos) ? bag.logos : [];
  const refsIn = Array.isArray(bag.referencePhotos) ? bag.referencePhotos : [];
  const cardsIn = Array.isArray(bag.businessCard)
    ? bag.businessCard
    : bag.businessCard
      ? [bag.businessCard]
      : [];

  const uploaded = [];
  try {
    const logos = [];
    const referencePhotos = [];
    let businessCard = null;

    if (enquiryType === 'bulk') {
      if (cardsIn[0]) {
        businessCard = await uploadOneFile(cardsIn[0], {
          folder: 'gift-enquiries/business-cards',
          kind: 'business_card',
          allowPdf: true,
          allowImage: true
        });
        uploaded.push(businessCard);
      }
    }

    if (enquiryType === 'custom') {
      for (const file of logosIn) {
        const asset = await uploadOneFile(file, {
          folder: 'gift-enquiries/logos',
          kind: 'logo',
          allowPdf: true,
          allowImage: true
        });
        logos.push(asset);
        uploaded.push(asset);
      }
      for (const file of refsIn) {
        const asset = await uploadOneFile(file, {
          folder: 'gift-enquiries/references',
          kind: 'reference',
          allowPdf: false,
          allowImage: true
        });
        referencePhotos.push(asset);
        uploaded.push(asset);
      }
    }

    return { logos, referencePhotos, businessCard, uploaded };
  } catch (err) {
    await rollbackAssets(uploaded);
    throw err;
  }
}

module.exports = {
  uploadGiftEnquiryFiles,
  rollbackAssets,
  mediaConfigured,
  MAX_FILE_BYTES
};
