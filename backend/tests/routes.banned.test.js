"use strict";

jest.mock('../src/lightspeedClient', () => ({
  recordVerification: jest.fn(),
  getSaleById: jest.fn().mockResolvedValue({
    saleId: 'SALE-1',
    total: 10,
    items: [],
    verification: null
  }),
  completeSale: jest.fn(),
  listSales: jest.fn()
}));

jest.mock('../src/complianceStore', () => ({
  saveVerification: jest.fn().mockResolvedValue({ id: 'comp-1' }),
  getLatestVerificationForSale: jest.fn(),
  recordSaleCompletion: jest.fn(),
  summarizeCompliance: jest.fn(),
  findBannedCustomer: jest.fn(),
  addBannedCustomer: jest.fn(),
  listBannedCustomers: jest.fn(),
  removeBannedCustomer: jest.fn()
}));

jest.mock('../src/db', () => ({
  pool: {},
  query: jest.fn()
}));

const request = require('supertest');
const { app } = require('../src/app');
const lightspeed = require('../src/lightspeedClient');
const complianceStore = require('../src/complianceStore');

describe('Verification banned customer flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.API_SECRET_KEY = '';
  });

  it('flags verification when banned customer is found', async () => {
    complianceStore.findBannedCustomer.mockResolvedValue({
      id: 'ban-1',
      notes: 'Chargeback dispute'
    });

    lightspeed.recordVerification.mockResolvedValue({
      verificationId: 'ver-1',
      saleId: 'SALE-1',
      status: 'approved',
      firstName: 'Banned',
      lastName: 'Customer',
      dob: '1990-01-01',
      age: 34
    });

    const res = await request(app)
      .post('/api/sales/SALE-1/verify')
      .send({
        clerkId: 'clerk-1',
        scan: {
          approved: true,
          firstName: 'Banned',
          lastName: 'Customer',
          dob: '1990-01-01',
          age: 34,
          documentType: 'passport',
          documentNumber: 'p1234567',
          issuingCountry: 'usa',
          nationality: 'us',
          documentExpiry: '2030-01-01',
          sex: 'female'
        }
      })
      .expect(201);

    expect(complianceStore.findBannedCustomer).toHaveBeenCalledWith({
      documentType: 'passport',
      documentNumber: 'P1234567',
      issuingCountry: 'USA'
    });
    expect(res.body.data.banned).toBe(true);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.bannedReason).toBe('Chargeback dispute');
    expect(lightspeed.recordVerification).toHaveBeenCalled();
  });

  it('allows verification when ID is not banned', async () => {
    complianceStore.findBannedCustomer.mockResolvedValue(null);

    lightspeed.recordVerification.mockResolvedValue({
      verificationId: 'ver-2',
      saleId: 'SALE-1',
      status: 'approved',
      firstName: 'Jane',
      lastName: 'Doe',
      dob: '1995-05-05',
      age: 29
    });

    const res = await request(app)
      .post('/api/sales/SALE-1/verify')
      .send({
        clerkId: 'clerk-2',
        scan: {
          approved: true,
          firstName: 'Jane',
          lastName: 'Doe',
          dob: '1995-05-05',
          age: 29,
          documentType: 'drivers_license',
          documentNumber: 'd111222',
          issuingCountry: 'usa',
          nationality: 'usa',
          documentExpiry: '2030-01-15',
          sex: 'f'
        }
      })
      .expect(201);

    expect(complianceStore.findBannedCustomer).toHaveBeenCalled();
    expect(res.body.data.banned).toBe(false);
    expect(res.body.data.status).toBe('approved');

    const verificationData = lightspeed.recordVerification.mock.calls[0][0].verificationData;
    expect(verificationData.documentNumber).toBe('D111222');
    expect(verificationData.issuingCountry).toBe('USA');
    expect(verificationData.nationality).toBe('USA');
    expect(verificationData.documentExpiry).toBe('2030-01-15');
    expect(verificationData.sex).toBe('F');
  });
});
