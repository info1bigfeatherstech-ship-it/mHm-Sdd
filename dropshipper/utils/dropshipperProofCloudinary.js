const path = require('path');
const { uploadBufferToR2 } = require('../../utils/r2Storage');
const { optimizeProductImageBuffer } = require('../../utils/cloudinaryHelper');

function sanitizePublicIdPart(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'proof'
  );
}

function sanitizeEmailFolder(email) {
  return (
    String(email || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9@._-]/g, '-')
      .replace(/@/g, '_at_')
      .replace(/\.+/g, '.')
      .replace(/-+/g, '-')
      .slice(0, 80) || 'unknown'
  );
}

/**
 * Upload registration proof (image or PDF) — mirrors wholesaler uploadProofBufferToCloudinary
 * (R2-backed) into dropshipper/registration/{email}/id|business.
 */
async function uploadProofBufferToCloudinary(file, folder, publicIdPrefix) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new Error('Proof upload failed: empty or invalid file buffer');
  }
  if (file.buffer.length > 5 * 1024 * 1024) {
    throw new Error('Proof upload failed: file exceeds max size limit of 5MB');
  }

  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const isPdf = file.mimetype === 'application/pdf' || ext === '.pdf';
  const publicId = `${publicIdPrefix}-${Date.now()}`;

  if (isPdf) {
    const upload = await uploadBufferToR2({
      buffer: file.buffer,
      folderPath: folder,
      publicIdName: publicId,
      contentType: 'application/pdf',
      extension: 'pdf',
      cacheControl: 'public, max-age=31536000, immutable'
    });
    return {
      url: upload.url,
      publicId: `r2:${upload.key}`,
      resourceType: 'raw'
    };
  }

  const optimizedBuffer = await optimizeProductImageBuffer(file.buffer);
  const upload = await uploadBufferToR2({
    buffer: optimizedBuffer,
    folderPath: folder,
    publicIdName: publicId,
    contentType: 'image/webp',
    extension: 'webp',
    cacheControl: 'public, max-age=31536000, immutable'
  });
  return {
    url: upload.url,
    publicId: `r2:${upload.key}`,
    resourceType: 'image'
  };
}

async function uploadRegistrationProofs(files, email) {
  const folderBase = `dropshipper/registration/${sanitizeEmailFolder(email)}`;
  const bag = files || {};
  const pickFirst = (...keys) => {
    for (const key of keys) {
      if (Array.isArray(bag[key]) && bag[key][0]) return bag[key][0];
    }
    return null;
  };

  const idProofFile = pickFirst('idProof', 'idProofUpload', 'idProofFile');
  const businessProofFile = pickFirst(
    'businessAddressProof',
    'businessAddressProofUpload',
    'businessAddressProofFile'
  );

  const result = {
    idProofUrl: null,
    idProofPublicId: null,
    businessAddressProofUrl: null,
    businessAddressProofPublicId: null
  };

  const uploads = [];

  if (idProofFile) {
    uploads.push(
      uploadProofBufferToCloudinary(
        idProofFile,
        `${folderBase}/id`,
        sanitizePublicIdPart(`${email}-id-proof`)
      ).then((r) => {
        result.idProofUrl = r.url;
        result.idProofPublicId = r.publicId;
      })
    );
  }

  if (businessProofFile) {
    uploads.push(
      uploadProofBufferToCloudinary(
        businessProofFile,
        `${folderBase}/business`,
        sanitizePublicIdPart(`${email}-business-proof`)
      ).then((r) => {
        result.businessAddressProofUrl = r.url;
        result.businessAddressProofPublicId = r.publicId;
      })
    );
  }

  if (uploads.length) {
    await Promise.all(uploads);
  }

  return result;
}

module.exports = {
  sanitizePublicIdPart,
  sanitizeEmailFolder,
  uploadProofBufferToCloudinary,
  uploadRegistrationProofs
};
