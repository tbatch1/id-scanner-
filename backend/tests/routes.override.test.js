"use strict";

jest.mock('../src/lightspeedClient', () => ({
  recordVerification: jest.fn(),
  getSaleById: jest.fn(),
  completeSale: jest.fn(),
  listSales: jest.fn()
}));

jest.mock('../src/complianceStore', () => ({
  saveVerification: jest.fn(),
  getLatestVerificationForSale: jest.fn(),
  recordSaleCompletion: jest.fn(),
  summarizeCompliance: jest.fn(),
  findBannedCustomer: jest.fn(),
  addBannedCustomer: jest.fn(),
  listBannedCustomers: jest.fn(),
  removeBannedCustomer: jest.fn(),
  markVerificationOverride: jest.fn(),
  listOverridesForSale: jest.fn(),
  listRecentOverrides: jest.fn()
}));

jest.mock('../src/db', () => ({
  pool: {},
  query: jest.fn()
}));

const request = require('supertest');
const { app } = require('../src/app');
const complianceStore = require('../src/complianceStore');

describe('Override endpoint', () => {
  beforeEach(() => {
    process.env.OVERRIDE_PIN = '1234';
    complianceStore.getLatestVerificationForSale.mockReset();
    complianceStore.markVerificationOverride.mockReset();
    complianceStore.listOverridesForSale.mockReset();
    complianceStore.listRecentOverrides.mockReset();
  });

  afterAll(() => {
    delete process.env.OVERRIDE_PIN;
  });

  it('rejects invalid manager pin', async () => {
    const res = await request(app)
      .post('/api/sales/SALE-1/override')
      .send({
        verificationId: 'ver-1',
        managerPin: '0000'
      })
      .expect(403);

    expect(res.body.error).toBe('INVALID_PIN');
    expect(complianceStore.markVerificationOverride).not.toHaveBeenCalled();
  });

  it('approves override and returns updated verification', async () => {
    complianceStore.getLatestVerificationForSale.mockResolvedValue({
      verification_id: 'ver-1',
      sale_id: 'SALE-1',
      status: 'rejected',
      reason: 'Underage'
    });

    complianceStore.markVerificationOverride.mockResolvedValue({
      verification: {
        verification_id: 'ver-1',
        sale_id: 'SALE-1',
        clerk_id: 'clerk-1',
        status: 'approved_override',
        reason: 'Manual check',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      override: {
        id: 'ovr-1',
        verification_id: 'ver-1',
        sale_id: 'SALE-1',
        manager_id: 'manager',
        note: 'Manual check',
        created_at: new Date().toISOString()
      }
    });

    const res = await request(app)
      .post('/api/sales/SALE-1/override')
      .send({
        verificationId: 'ver-1',
        managerPin: '1234',
        managerId: 'manager',
        note: 'Manual check'
      })
      .expect(200);

    expect(complianceStore.markVerificationOverride).toHaveBeenCalled();
    expect(res.body.data.verification.status).toBe('approved_override');
    expect(res.body.data.override).toBeTruthy();
  });

  it('lists overrides for a sale', async () => {
    complianceStore.listOverridesForSale.mockResolvedValue([
      {
        id: 'ovr-1',
        verification_id: 'ver-1',
        sale_id: 'SALE-1',
        manager_id: 'manager-1',
        note: 'Manual check',
        created_at: new Date().toISOString()
      }
    ]);

    const res = await request(app).get('/api/sales/SALE-1/overrides').expect(200);

    expect(complianceStore.listOverridesForSale).toHaveBeenCalledWith('SALE-1');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].manager_id).toBe('manager-1');
  });

  it('returns 500 when overrides lookup fails', async () => {
    complianceStore.listOverridesForSale.mockRejectedValue(new Error('boom'));

    const res = await request(app).get('/api/sales/SALE-1/overrides').expect(500);

    expect(res.body.error).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('Unable to fetch overrides for this sale.');
  });

  it('returns recent override history', async () => {
    complianceStore.listRecentOverrides.mockResolvedValue([
      {
        id: 'ovr-2',
        verificationId: 'ver-9',
        saleId: 'SALE-99',
        managerId: 'mgr-9',
        note: 'Manual passport review',
        createdAt: new Date().toISOString()
      }
    ]);

    const res = await request(app).get('/api/reports/overrides?days=15&limit=5').expect(200);

    expect(complianceStore.listRecentOverrides).toHaveBeenCalledWith({ days: 15, limit: 5 });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].managerId).toBe('mgr-9');
  });

  it('handles override history errors', async () => {
    complianceStore.listRecentOverrides.mockRejectedValue(new Error('boom'));

    const res = await request(app).get('/api/reports/overrides').expect(500);

    expect(res.body.error).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('Unable to fetch override history.');
  });
});
