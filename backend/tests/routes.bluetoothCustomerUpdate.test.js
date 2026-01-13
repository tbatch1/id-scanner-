"use strict";

jest.mock('../src/lightspeedClient', () => ({
  recordVerification: jest.fn(),
  getSaleById: jest.fn(),
  updateCustomerById: jest.fn()
}));

jest.mock('../src/complianceStore', () => ({
  logDiagnostic: jest.fn(),
  findBannedCustomer: jest.fn(),
  saveVerification: jest.fn(),
  getLatestVerificationForSale: jest.fn(),
  recordSaleCompletion: jest.fn(),
  summarizeCompliance: jest.fn(),
  addBannedCustomer: jest.fn(),
  listBannedCustomers: jest.fn(),
  removeBannedCustomer: jest.fn(),
  markVerificationOverride: jest.fn(),
  listOverridesForSale: jest.fn(),
  listRecentOverrides: jest.fn(),
  enforceRetention: jest.fn()
}));

jest.mock('../src/db', () => ({
  pool: null,
  query: jest.fn()
}));

const request = require('supertest');
const { app } = require('../src/app');
const lightspeed = require('../src/lightspeedClient');
const complianceStore = require('../src/complianceStore');

jest.setTimeout(15000);

describe('Bluetooth verify updates customer fields', () => {
  beforeEach(() => {
    lightspeed.getSaleById.mockReset();
    lightspeed.recordVerification.mockReset();
    lightspeed.updateCustomerById.mockReset();

    complianceStore.logDiagnostic.mockReset();
    complianceStore.findBannedCustomer.mockReset();
    complianceStore.saveVerification.mockReset();

    complianceStore.logDiagnostic.mockResolvedValue(null);
    complianceStore.findBannedCustomer.mockResolvedValue(null);
    complianceStore.saveVerification.mockResolvedValue(null);
  });

  it('returns quickly without blocking on customer profile updates', async () => {
    lightspeed.getSaleById.mockResolvedValue({
      saleId: 'SALE-1',
      items: [],
      customerId: 'CUST-1',
      note: ''
    });
    lightspeed.recordVerification.mockResolvedValue({ noteUpdated: false });
    lightspeed.updateCustomerById.mockResolvedValue({ updated: true, fields: ['first_name'] });

    const barcodeData = [
      'DAQD1234567',
      'DCSDOE',
      'DACJOHN',
      'DBB19800101',
      'DBC1',
      'DAG123 MAIN ST',
      'DAICITY',
      'DAJTX',
      'DAK78701'
    ].join('\n');

    const res = await request(app)
      .post('/api/sales/SALE-1/verify-bluetooth')
      .send({ barcodeData, registerId: 'REG-1', clerkId: 'clerk-1' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.approved).toBe(true);
    expect(res.body.customerReconcileQueued).toBe(false);

    // Fast verify path: customer updates happen asynchronously via reconcile jobs, so this endpoint should not write.
    expect(lightspeed.updateCustomerById).toHaveBeenCalledTimes(0);
  });
});
