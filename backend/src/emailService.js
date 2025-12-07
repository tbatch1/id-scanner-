const nodemailer = require('nodemailer');
const logger = require('./logger');

// Configure transporter
// In production, these should be environment variables
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false, // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

/**
 * Send an alert email to managers
 * @param {string} subject - Email subject
 * @param {string} htmlContent - Email body (HTML)
 */
async function sendAlertEmail(subject, htmlContent) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        logger.warn({ event: 'email_skipped', subject }, 'SMTP credentials not configured. Skipping email.');
        return;
    }

    const mailOptions = {
        from: process.env.SMTP_FROM || '"ID Scanner Alert" <alerts@thcclub.com>',
        to: process.env.ALERT_RECIPIENT || 'managers@thcclub.com',
        subject: `[ID Scanner Alert] ${subject}`,
        html: htmlContent
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        logger.info({ event: 'email_sent', messageId: info.messageId, subject }, 'Alert email sent successfully');
        return info;
    } catch (error) {
        logger.error({ event: 'email_failed', error: error.message }, 'Failed to send alert email');
        // Don't throw, just log. We don't want to break the flow if email fails.
    }
}

module.exports = {
    sendAlertEmail
};
