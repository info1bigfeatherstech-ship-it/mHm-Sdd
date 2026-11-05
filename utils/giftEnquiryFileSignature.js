/**
 * Magic-byte checks for gift-enquiry uploads (images + PDF).
 * MIME from clients is untrusted — verify buffer headers before storage.
 */

const IMAGE_SIGNATURES = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], webp: true }, // RIFF....WEBP
  { mime: 'image/bmp', bytes: [0x42, 0x4d] }
];

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46]; // %PDF

function matchesPrefix(buffer, signature) {
  if (!Buffer.isBuffer(buffer) || buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

function isWebp(buffer) {
  if (!matchesPrefix(buffer, [0x52, 0x49, 0x46, 0x46])) return false;
  if (buffer.length < 12) return false;
  return buffer.slice(8, 12).toString('ascii') === 'WEBP';
}

/**
 * @param {Buffer} buffer
 * @returns {{ ok: true, kind: 'image'|'pdf', detectedMime: string } | { ok: false, code: string, message: string }}
 */
function detectGiftEnquiryFileKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: 'Empty file buffer' };
  }

  if (matchesPrefix(buffer, PDF_SIGNATURE)) {
    return { ok: true, kind: 'pdf', detectedMime: 'application/pdf' };
  }

  if (isWebp(buffer)) {
    return { ok: true, kind: 'image', detectedMime: 'image/webp' };
  }

  for (const sig of IMAGE_SIGNATURES) {
    if (sig.webp) continue;
    if (matchesPrefix(buffer, sig.bytes)) {
      return { ok: true, kind: 'image', detectedMime: sig.mime };
    }
  }

  return {
    ok: false,
    code: 'INVALID_FILE_SIGNATURE',
    message: 'File content does not match an allowed image or PDF type'
  };
}

/**
 * @param {Buffer} buffer
 * @param {{ allowPdf?: boolean, allowImage?: boolean }} opts
 */
function assertGiftEnquiryFileAllowed(buffer, opts = {}) {
  const allowPdf = opts.allowPdf !== false;
  const allowImage = opts.allowImage !== false;
  const detected = detectGiftEnquiryFileKind(buffer);
  if (!detected.ok) return detected;

  if (detected.kind === 'pdf' && !allowPdf) {
    return {
      ok: false,
      code: 'PDF_NOT_ALLOWED',
      message: 'PDF files are not allowed for this field'
    };
  }
  if (detected.kind === 'image' && !allowImage) {
    return {
      ok: false,
      code: 'IMAGE_NOT_ALLOWED',
      message: 'Image files are not allowed for this field'
    };
  }
  return detected;
}

module.exports = {
  detectGiftEnquiryFileKind,
  assertGiftEnquiryFileAllowed
};
