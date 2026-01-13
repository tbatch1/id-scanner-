function safeIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function normalizeLightspeedGender(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  // Lightspeed X-Series expects single-letter codes for gender (ex: 'M'); sending 'male' returns 400.
  if (lower === 'm' || lower === 'male') return 'M';
  if (lower === 'f' || lower === 'female') return 'F';
  if (lower === 'x' || lower === 'other' || lower === 'nonbinary' || lower === 'non-binary') return 'X';

  return null;
}

function buildCustomerUpdatePayload(parsed = {}) {
  const gender = normalizeLightspeedGender(parsed.sex || parsed.gender);
  const dateOfBirth = safeIsoDate(parsed.dob || parsed.dateOfBirth);

  return {
    first_name: parsed.firstName || null,
    last_name: parsed.lastName || null,
    date_of_birth: dateOfBirth,
    gender,

    // Lightspeed Retail (X-Series) uses underscore-number field names for addresses.
    physical_address_1: parsed.address1 || null,
    physical_address_2: parsed.address2 || null,
    physical_suburb: parsed.suburb || null,
    physical_city: parsed.city || null,
    physical_state: parsed.state || null,
    physical_postcode: parsed.postalCode || null,

    postal_address_1: parsed.address1 || null,
    postal_address_2: parsed.address2 || null,
    postal_suburb: parsed.suburb || null,
    postal_city: parsed.city || null,
    postal_state: parsed.state || null,
    postal_postcode: parsed.postalCode || null
  };
}

module.exports = {
  buildCustomerUpdatePayload,
  normalizeLightspeedGender
};
