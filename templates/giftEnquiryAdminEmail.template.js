/**
 * Admin notify email for corporate gift / bulk enquiry (includes file links).
 */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fileLinks(assets, label) {
  const list = Array.isArray(assets) ? assets.filter((a) => a && a.url) : [];
  if (!list.length) return '';
  const items = list
    .map((a, i) => {
      const name = esc(a.originalName || `${label} ${i + 1}`);
      return `<li><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${name}</a> <span style="color:#888;font-size:12px;">(${esc(a.mimeType || 'file')})</span></li>`;
    })
    .join('');
  return `<p style="margin:12px 0 4px 0;font-weight:600;color:#333;">${esc(label)}</p><ul style="margin:0;padding-left:18px;">${items}</ul>`;
}

module.exports = {
  buildSubject({ enquiryType, storefront, name, appName }) {
    const label = enquiryType === 'bulk' ? 'Bulk' : 'Custom gift';
    return `[${String(storefront || 'ecomm').toUpperCase()}] ${label} enquiry — ${name || 'Customer'} · ${appName}`;
  },

  buildText(doc) {
    const lines = [
      `New ${doc.enquiryType} gift enquiry (${doc.storefront})`,
      `Name: ${doc.name}`,
      `Phone: ${doc.phone}`,
      `Email: ${doc.email || '—'}`,
      `Organization: ${doc.organizationName || '—'}`,
      `City: ${doc.city || '—'}`,
      `Status: ${doc.status}`,
      `Id: ${doc._id}`,
      ''
    ];
    if (doc.enquiryType === 'bulk') {
      lines.push(`Business type: ${doc.businessType || '—'}`);
      lines.push(`Volume order: ${doc.volumeOrder != null ? doc.volumeOrder : '—'}`);
    } else {
      lines.push(`Occasion: ${doc.occasion || '—'}`);
      lines.push(`Gift category: ${doc.giftCategory || '—'}`);
      lines.push(`Quantity: ${doc.quantity != null ? doc.quantity : '—'}`);
      lines.push(
        `Target delivery: ${doc.targetDeliveryDate ? new Date(doc.targetDeliveryDate).toISOString().slice(0, 10) : '—'}`
      );
    }
    if (doc.message) {
      lines.push('', 'Message:', doc.message);
    }
    const files = [];
    if (doc.businessCard?.url) files.push(`Business card: ${doc.businessCard.url}`);
    for (const a of doc.logos || []) if (a?.url) files.push(`Logo: ${a.url}`);
    for (const a of doc.referencePhotos || []) if (a?.url) files.push(`Reference: ${a.url}`);
    if (files.length) {
      lines.push('', 'Files:', ...files);
    }
    return lines.join('\n');
  },

  buildHtml(doc, appName) {
    const label = doc.enquiryType === 'bulk' ? 'Bulk order' : 'Custom gift';
    const typeRows =
      doc.enquiryType === 'bulk'
        ? `
      <tr><td style="padding:6px 0;color:#666;">Business type</td><td style="padding:6px 0;">${esc(doc.businessType)}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Volume</td><td style="padding:6px 0;">${esc(doc.volumeOrder != null ? doc.volumeOrder : '—')}</td></tr>`
        : `
      <tr><td style="padding:6px 0;color:#666;">Occasion</td><td style="padding:6px 0;">${esc(doc.occasion)}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Category</td><td style="padding:6px 0;">${esc(doc.giftCategory)}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Quantity</td><td style="padding:6px 0;">${esc(doc.quantity)}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Target delivery</td><td style="padding:6px 0;">${esc(doc.targetDeliveryDate ? new Date(doc.targetDeliveryDate).toISOString().slice(0, 10) : '—')}</td></tr>`;

    const messageBlock = doc.message
      ? `<p style="margin:16px 0 4px 0;font-weight:600;color:#333;">Message</p><p style="white-space:pre-wrap;color:#444;background:#fafafa;padding:12px;border-radius:8px;border:1px solid #eee;">${esc(doc.message)}</p>`
      : '';

    return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:10px;">
  <h2 style="margin:0 0 8px 0;color:#1a1a1a;font-size:20px;">${esc(appName)} — ${esc(label)} enquiry</h2>
  <p style="color:#888;font-size:13px;margin:0 0 16px 0;">Storefront: <strong>${esc(doc.storefront)}</strong> · Id: ${esc(String(doc._id))}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:6px 0;color:#666;width:140px;">Name</td><td style="padding:6px 0;">${esc(doc.name)}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">Phone</td><td style="padding:6px 0;">${esc(doc.phone)}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">Email</td><td style="padding:6px 0;">${esc(doc.email || '—')}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">Organization</td><td style="padding:6px 0;">${esc(doc.organizationName || '—')}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">City</td><td style="padding:6px 0;">${esc(doc.city || '—')}</td></tr>
    ${typeRows}
  </table>
  ${messageBlock}
  ${fileLinks(doc.businessCard ? [doc.businessCard] : [], 'Business card')}
  ${fileLinks(doc.logos, 'Logos')}
  ${fileLinks(doc.referencePhotos, 'Reference photos')}
</div>`.trim();
  }
};
