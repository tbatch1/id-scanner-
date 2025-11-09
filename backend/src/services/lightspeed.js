const config = require('../config');

function mapLightspeedError(error = {}) {
  const status =
    error.status ||
    error.code ||
    (error.response && error.response.status) ||
    (error.details && error.details.status) ||
    null;

  const payload = error.details || (error.response && error.response.data) || {};

  return {
    status,
    code: payload.code || error.code || null,
    message: payload.message || payload.error_description || error.message || 'Lightspeed request failed',
    raw: payload
  };
}

function buildVerificationNote(record, locationId) {
  if (!record) return '';

  const fragments = [
    record.status ? `Verification ${String(record.status).toUpperCase()}` : null,
    record.reason ? `Reason: ${record.reason}` : null,
    record.firstName || record.lastName
      ? `Name: ${[record.firstName, record.middleName, record.lastName].filter(Boolean).join(' ')}`
      : null,
    record.dob ? `DOB: ${record.dob}` : null,
    record.documentType ? `Document: ${record.documentType}` : null,
    record.documentNumber ? `Number: ${record.documentNumber}` : null,
    locationId ? `Location: ${locationId}` : null,
    record.source ? `Source: ${record.source}` : null
  ];

  return fragments.filter(Boolean).join(' | ');
}

function resolvePaymentTypeId(paymentType) {
  const types = config.lightspeed?.paymentTypes || {};
  if (paymentType && types[paymentType]) {
    return types[paymentType];
  }

  if (types.cash) {
    return types.cash;
  }

  return null;
}

module.exports = {
  mapLightspeedError,
  buildVerificationNote,
  resolvePaymentTypeId
};
