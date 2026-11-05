/**
 * Fire-and-forget emails after gift enquiry create.
 * From: EMAIL_USER. Admin to: GIFT_ENQUIRY_NOTIFY_EMAIL || EMAIL_USER.
 */
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { getAppName } = require('../utils/appName');
const customerTpl = require('../templates/giftEnquiryCustomerEmail.template');
const adminTpl = require('../templates/giftEnquiryAdminEmail.template');

let cachedTransporter = null;

function getEmailUser() {
  return String(process.env.EMAIL_USER || '').trim();
}

function getEmailPassword() {
  return String(process.env.EMAIL_PASSWORD || '').trim();
}

function getAdminNotifyEmail() {
  return (
    String(process.env.GIFT_ENQUIRY_NOTIFY_EMAIL || '').trim() || getEmailUser()
  );
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const user = getEmailUser();
  const pass = getEmailPassword();
  if (!user || !pass) {
    const err = new Error('EMAIL_USER / EMAIL_PASSWORD not configured');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
  return cachedTransporter;
}

function fromAddress(appName) {
  const user = getEmailUser();
  return `"${appName}" <${user}>`;
}

function buildCustomerSummaryLines(doc) {
  const lines = [
    ['Enquiry', doc.enquiryType === 'bulk' ? 'Bulk order' : 'Custom gift'],
    ['Phone', doc.phone || '—']
  ];
  if (doc.enquiryType === 'bulk') {
    lines.push(['Business type', doc.businessType || '—']);
    if (doc.volumeOrder != null) lines.push(['Volume', String(doc.volumeOrder)]);
  } else {
    lines.push(['Occasion', doc.occasion || '—']);
    lines.push(['Category', doc.giftCategory || '—']);
    lines.push(['Quantity', doc.quantity != null ? String(doc.quantity) : '—']);
  }
  if (doc.city) lines.push(['City', doc.city]);
  return lines;
}

async function sendCustomerAck(doc) {
  const to = String(doc.email || '').trim();
  if (!to) return { skipped: true, reason: 'no_customer_email' };

  const appName = getAppName();
  const transporter = getTransporter();
  await transporter.sendMail({
    from: fromAddress(appName),
    to,
    subject: customerTpl.buildSubject({ enquiryType: doc.enquiryType, appName }),
    text: customerTpl.buildText({ enquiryType: doc.enquiryType, name: doc.name, appName }),
    html: customerTpl.buildHtml({
      enquiryType: doc.enquiryType,
      name: doc.name,
      phone: doc.phone,
      email: doc.email,
      organizationName: doc.organizationName,
      city: doc.city,
      appName,
      summaryLines: buildCustomerSummaryLines(doc)
    })
  });
  return { sent: true };
}

async function sendAdminNotify(doc) {
  const to = getAdminNotifyEmail();
  if (!to) return { skipped: true, reason: 'no_admin_email' };

  const appName = getAppName();
  const transporter = getTransporter();
  await transporter.sendMail({
    from: fromAddress(appName),
    to,
    subject: adminTpl.buildSubject({
      enquiryType: doc.enquiryType,
      storefront: doc.storefront,
      name: doc.name,
      appName
    }),
    text: adminTpl.buildText(doc),
    html: adminTpl.buildHtml(doc, appName)
  });
  return { sent: true };
}

/**
 * Non-blocking: enqueue both emails after successful DB create.
 * Never throws to the HTTP path — logs failures.
 */
function enqueueGiftEnquiryEmails(doc) {
  const plain =
    doc && typeof doc.toObject === 'function'
      ? doc.toObject()
      : doc && typeof doc === 'object'
        ? { ...doc }
        : null;

  if (!plain) return;

  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        try {
          await sendAdminNotify(plain);
        } catch (err) {
          logger.error('[gift-enquiry] admin notify email failed', {
            enquiryId: String(plain._id || ''),
            message: err?.message || String(err)
          });
        }
        try {
          await sendCustomerAck(plain);
        } catch (err) {
          logger.error('[gift-enquiry] customer ack email failed', {
            enquiryId: String(plain._id || ''),
            message: err?.message || String(err)
          });
        }
      })
      .catch((err) => {
        logger.error('[gift-enquiry] email enqueue failed', {
          message: err?.message || String(err)
        });
      });
  });
}

module.exports = {
  enqueueGiftEnquiryEmails,
  sendCustomerAck,
  sendAdminNotify,
  getAdminNotifyEmail
};
