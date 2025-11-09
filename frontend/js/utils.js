export function calculateAge(dobString) {
  if (!dobString || dobString.length < 8) return null;

  let month;
  let day;
  let year;

  if (dobString.length === 8) {
    const monthCandidate = parseInt(dobString.substring(0, 2), 10);
    if (monthCandidate > 12) {
      year = parseInt(dobString.substring(0, 4), 10);
      month = parseInt(dobString.substring(4, 6), 10);
      day = parseInt(dobString.substring(6, 8), 10);
    } else {
      month = monthCandidate;
      day = parseInt(dobString.substring(2, 4), 10);
      year = parseInt(dobString.substring(4, 8), 10);
    }
  } else if (dobString.includes('-')) {
    const parts = dobString.split('-');
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    day = parseInt(parts[2], 10);
  } else {
    return null;
  }

  if ([month, day, year].some((value) => Number.isNaN(value))) return null;

  const dob = new Date(year, month - 1, day);
  if (Number.isNaN(dob.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }

  return {
    age,
    formatted: `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`,
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  };
}

function normalizeDateString(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length === 8) {
    const year = digits.substring(0, 4);
    const month = digits.substring(4, 6);
    const day = digits.substring(6, 8);
    const monthNum = Number(month);
    const dayNum = Number(day);
    if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
      return `${year}-${month}-${day}`;
    }
  }

  return '';
}

function normalizeSex(value) {
  if (!value) return '';
  const trimmed = String(value).trim().toUpperCase();
  if (trimmed === 'M' || trimmed.startsWith('MALE')) return 'M';
  if (trimmed === 'F' || trimmed.startsWith('FEMALE')) return 'F';
  if (trimmed === 'X' || trimmed.startsWith('NON')) return 'X';
  return '';
}

export function parseLicenseData(parsedInfo) {
  const data = {
    firstName: '',
    lastName: '',
    middleName: '',
    dob: '',
    licenseNumber: '',
    documentType: 'drivers_license',
    issuingCountry: '',
    documentExpiry: '',
    nationality: '',
    sex: ''
  };

  function extractFields(fields) {
    for (const field of fields) {
      if (Array.isArray(field)) {
        extractFields(field);
      } else {
        if (!field) continue;

        if (field.ChildFields) extractFields(field.ChildFields);
        if (!field.FieldName || !field.Value) continue;

        const fieldName = field.FieldName.toLowerCase();
        const value = field.Value;

        if (
          fieldName === 'givenname' ||
          fieldName === 'firstname' ||
          fieldName === 'given_name' ||
          fieldName === 'first_name' ||
          fieldName === 'dcdname' ||
          fieldName === 'customerfirstname'
        ) {
          data.firstName = value;
        }

        if (
          fieldName === 'familyname' ||
          fieldName === 'lastname' ||
          fieldName === 'family_name' ||
          fieldName === 'last_name' ||
          fieldName === 'surname' ||
          fieldName === 'dcsname' ||
          fieldName === 'customerfamilyname'
        ) {
          data.lastName = value;
        }

        if (fieldName === 'middlename' || fieldName === 'middle_name' || fieldName === 'ddename') {
          data.middleName = value;
        }

        if (
          fieldName === 'birthdate' ||
          fieldName === 'dateofbirth' ||
          fieldName === 'birth_date' ||
          fieldName === 'date_of_birth' ||
          fieldName === 'dob' ||
          fieldName === 'dbbname'
        ) {
          data.dob = value;
        }

        if (
          fieldName === 'licensenumber' ||
          fieldName === 'license_number' ||
          fieldName === 'dlnumber' ||
          fieldName === 'daqname' ||
          fieldName === 'customernumber' ||
          fieldName === 'documentnumber'
        ) {
          data.licenseNumber = value;
        }

        if (
          fieldName === 'issuingcountry' ||
          fieldName === 'issuing_country' ||
          fieldName === 'issuingjurisdiction' ||
          fieldName === 'country' ||
          fieldName === 'jurisdiction'
        ) {
          data.issuingCountry = value;
        }

        if (
          fieldName === 'expirationdate' ||
          fieldName === 'expirydate' ||
          fieldName === 'documentexpirationdate' ||
          fieldName === 'expiry' ||
          fieldName === 'dba'
        ) {
          data.documentExpiry = value;
        }

        if (fieldName === 'nationality' || fieldName === 'citizenship') {
          data.nationality = value;
        }

        if (fieldName === 'sex' || fieldName === 'gender' || fieldName === 'dbc' || fieldName === 'dbcname') {
          data.sex = value;
        }
      }
    }
  }

  if (parsedInfo.ResultInfo) {
    extractFields(parsedInfo.ResultInfo);
  }

  if (!data.documentNumber && data.licenseNumber) {
    data.documentNumber = data.licenseNumber;
  }

  data.documentNumber = data.documentNumber ? String(data.documentNumber).trim().replace(/\s+/g, '').toUpperCase() : '';
  if (!data.documentNumber && data.licenseNumber) {
    data.documentNumber = String(data.licenseNumber).trim().replace(/\s+/g, '').toUpperCase();
  }
  if (data.licenseNumber) {
    data.licenseNumber = data.documentNumber;
  }

  data.issuingCountry = data.issuingCountry ? String(data.issuingCountry).trim().toUpperCase() : '';
  data.nationality = data.nationality ? String(data.nationality).trim().toUpperCase() : '';
  if (!data.nationality && data.issuingCountry) {
    data.nationality = data.issuingCountry;
  }

  data.documentExpiry = normalizeDateString(data.documentExpiry);
  data.sex = normalizeSex(data.sex);

  return data;
}

function expandTwoDigitYear(twoDigit) {
  const value = parseInt(twoDigit, 10);
  if (Number.isNaN(value)) return null;
  const current = new Date().getFullYear() % 100;
  const century = value > current ? 1900 : 2000;
  return century + value;
}

function parseMrzDate(raw) {
  if (!raw || raw.length < 6) return null;
  const year = expandTwoDigitYear(raw.substring(0, 2));
  const month = parseInt(raw.substring(2, 4), 10);
  const day = parseInt(raw.substring(4, 6), 10);
  if (!year || Number.isNaN(month) || Number.isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return {
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    formatted: `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`
  };
}

function extractMrzNames(raw = '') {
  const [last = '', rest = ''] = raw.split('<<');
  const givenParts = rest.split('<').filter(Boolean);
  const firstName = givenParts.shift() || '';
  const middleName = givenParts.join(' ').trim();
  return {
    lastName: last.replace(/<+/g, ' ').trim(),
    firstName: firstName.replace(/<+/g, ' ').trim(),
    middleName: middleName.replace(/<+/g, ' ').trim()
  };
}

function sanitizeMrzLines(lines = []) {
  return lines
    .map((line) => line.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9<]/g, ''))
    .filter((line) => line.length >= 30);
}

function parseTd3(lines) {
  const [line1, line2] = lines;
  const names = extractMrzNames(line1.substring(5));
  const docNum = line2.substring(0, 9).replace(/<+/g, '').trim();
  const nationality = line2.substring(10, 13).replace(/<+/g, '').trim();
  const issuingCountry = line1.substring(2, 5).replace(/<+/g, '').trim();
  const birth = parseMrzDate(line2.substring(13, 19));
  const expiry = parseMrzDate(line2.substring(21, 27));
  const sex = line2.substring(20, 21).replace('<', '') || 'U';
  return {
    documentType: 'passport',
    documentNumber: docNum ? docNum.toUpperCase() : '',
    issuingCountry,
    nationality,
    dob: birth?.iso || null,
    dobFormatted: birth?.formatted || null,
    documentExpiry: expiry?.iso || null,
    sex: normalizeSex(sex),
    ...names,
    source: 'mrz'
  };
}

function parseTd1(lines) {
  const [line1, line2, line3] = lines;
  const docNum = line1.substring(5, 14).replace(/<+/g, '').trim();
  const issuingCountry = line1.substring(2, 5).replace(/<+/g, '').trim();
  const names = extractMrzNames(line3);
  const birth = parseMrzDate(line2.substring(0, 6));
  const expiry = parseMrzDate(line2.substring(8, 14));
  const nationality = line2.substring(15, 18).replace(/<+/g, '').trim();
  const sex = line2.substring(7, 8).replace('<', '') || 'U';
  return {
    documentType: 'mrz_id',
    documentNumber: docNum ? docNum.toUpperCase() : '',
    issuingCountry,
    nationality,
    dob: birth?.iso || null,
    dobFormatted: birth?.formatted || null,
    documentExpiry: expiry?.iso || null,
    sex: normalizeSex(sex),
    ...names,
    source: 'mrz'
  };
}

export function parseMrz(lines = []) {
  const sanitized = sanitizeMrzLines(lines);
  if (!sanitized.length) return null;

  if (sanitized.length === 2 && sanitized[0].length >= 40 && sanitized[1].length >= 40) {
    return parseTd3(sanitized);
  }

  if (sanitized.length >= 3 && sanitized[0].length >= 30 && sanitized[1].length >= 30) {
    return parseTd1(sanitized.slice(0, 3));
  }

  return null;
}
