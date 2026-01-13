const { buildCustomerUpdatePayload, normalizeLightspeedGender } = require('../src/lightspeedCustomerFields');

describe('lightspeedCustomerFields', () => {
  test('normalizes gender values', () => {
    expect(normalizeLightspeedGender('M')).toBe('M');
    expect(normalizeLightspeedGender('male')).toBe('M');
    expect(normalizeLightspeedGender('F')).toBe('F');
    expect(normalizeLightspeedGender('female')).toBe('F');
    expect(normalizeLightspeedGender('X')).toBe('X');
    expect(normalizeLightspeedGender('')).toBe(null);
  });

  test('builds payload with correct Lightspeed field names', () => {
    const payload = buildCustomerUpdatePayload({
      firstName: 'Test',
      lastName: 'Customer',
      dob: new Date('2000-01-02T00:00:00.000Z'),
      sex: 'M',
      address1: '123 Main',
      address2: 'Apt 4',
      suburb: 'Heights',
      city: 'Houston',
      state: 'TX',
      postalCode: '77008'
    });

    expect(payload).toMatchObject({
      first_name: 'Test',
      last_name: 'Customer',
      date_of_birth: '2000-01-02',
      gender: 'M',
      physical_address_1: '123 Main',
      physical_address_2: 'Apt 4',
      physical_suburb: 'Heights',
      physical_city: 'Houston',
      physical_state: 'TX',
      physical_postcode: '77008',
      postal_address_1: '123 Main',
      postal_address_2: 'Apt 4',
      postal_suburb: 'Heights',
      postal_city: 'Houston',
      postal_state: 'TX',
      postal_postcode: '77008'
    });

    expect(Object.prototype.hasOwnProperty.call(payload, 'sex')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, 'physical_address1')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, 'postal_address1')).toBe(false);
  });
});
