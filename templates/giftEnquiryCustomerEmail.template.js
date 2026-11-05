/**
 * Customer acknowledgement email for corporate gift / bulk enquiry.
 * No file download links — summary only.
 */
module.exports = {
  buildSubject({ enquiryType, appName }) {
    const label = enquiryType === 'bulk' ? 'Bulk order' : 'Custom gift';
    return `${label} enquiry received — ${appName}`;
  },

  buildText({ enquiryType, name, appName }) {
    const label = enquiryType === 'bulk' ? 'bulk order' : 'custom gift';
    return [
      `Hi ${name || 'there'},`,
      '',
      `Thanks for your ${label} enquiry with ${appName}.`,
      'Our team has received your details and will get back to you shortly.',
      '',
      'If you did not submit this enquiry, you can ignore this email.',
      '',
      `— ${appName}`
    ].join('\n');
  },

  buildHtml({ enquiryType, name, phone, email, organizationName, city, appName, summaryLines }) {
    const label = enquiryType === 'bulk' ? 'Bulk order' : 'Custom gift';
    const rows = (summaryLines || [])
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 0;color:#666;width:140px;">${k}</td><td style="padding:6px 0;color:#222;">${v}</td></tr>`
      )
      .join('');

    return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:10px;">
  <h2 style="margin:0 0 12px 0;color:#1a1a1a;font-size:20px;">${appName}</h2>
  <p style="color:#444;line-height:1.6;margin:0 0 8px 0;">Hi ${name || 'there'},</p>
  <p style="color:#555;line-height:1.6;margin:0 0 16px 0;">
    Thanks for your <strong>${label.toLowerCase()}</strong> enquiry. Our team has received it and will contact you soon.
  </p>
  <table style="width:100%;border-collapse:collapse;margin:12px 0 8px 0;font-size:14px;">
    ${rows}
  </table>
  <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
    Phone on file: ${phone || '—'}${email ? ` · Email: ${email}` : ''}${organizationName ? ` · Org: ${organizationName}` : ''}${city ? ` · City: ${city}` : ''}
  </p>
</div>`.trim();
  }
};
