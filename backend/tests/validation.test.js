const { validateVerification } = require('../src/validation');
const { validationResult } = require('express-validator');

async function runValidation(customReq = {}) {
  const req = {
    params: { saleId: 'SALE-1001' },
    body: {
      clerkId: 'clerk-77',
      scan: {
        approved: true,
        firstName: 'Jane',
        lastName: 'Doe',
        middleName: 'Q',
        dob: '1999-01-01',
        age: 25,
        documentType: 'passport',
        documentNumber: 'P1234567',
        issuingCountry: 'USA',
        source: 'mrz'
      }
    },
    ip: '127.0.0.1',
    ...customReq
  };

  const chains = validateVerification.filter((middleware) => typeof middleware.run === 'function');
  await Promise.all(chains.map((middleware) => middleware.run(req)));

  return {
    req,
    result: validationResult(req)
  };
}

describe('validateVerification', () => {
  it('accepts verification payload with document metadata', async () => {
    const { result } = await runValidation();
    expect(result.isEmpty()).toBe(true);
  });

  it('rejects invalid document type values', async () => {
    const { result } = await runValidation({
      body: {
        clerkId: 'clerk-7',
        scan: {
          approved: true,
          firstName: 'Jane',
          lastName: 'Doe',
          age: 25,
          dob: '1999-01-01',
          documentType: 'passport#',
          documentNumber: 'P1234567',
          issuingCountry: 'USA',
          source: 'mrz'
        }
      }
    });

    expect(result.isEmpty()).toBe(false);
    const messages = result.array().map((error) => error.msg);
    expect(messages).toContain('Document type must be a short alphanumeric label');
  });

  it('rejects invalid ISO birth dates', async () => {
    const { result } = await runValidation({
      body: {
        clerkId: 'clerk-7',
        scan: {
          approved: true,
          firstName: 'Jane',
          lastName: 'Doe',
          age: 25,
          dob: '01-01-1999'
        }
      }
    });

    expect(result.isEmpty()).toBe(false);
    const messages = result.array().map((error) => error.msg);
    expect(messages).toContain('Date of birth must be in YYYY-MM-DD format and valid');
  });

  it('accepts MRZ ID document types with optional metadata', async () => {
    const { result } = await runValidation({
      body: {
        clerkId: 'clerk-88',
        scan: {
          approved: true,
          firstName: 'Alex',
          lastName: 'Kim',
          dob: '1995-07-04',
          documentType: 'mrz_id',
          documentNumber: 'L898902C',
          issuingCountry: 'CAN',
          nationality: 'CAN',
          source: 'mrz',
          sex: 'M'
        }
      }
    });

    expect(result.isEmpty()).toBe(true);
  });
});
