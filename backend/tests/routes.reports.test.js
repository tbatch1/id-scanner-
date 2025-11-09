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
  listRecentOverrides: jest.fn(),
  enforceRetention: jest.fn()
}));

jest.mock('../src/db', () => ({
  pool: {},
  query: jest.fn()
}));

const request = require('supertest');
const { app } = require('../src/app');
const complianceStore = require('../src/complianceStore');
const db = require('../src/db');

describe('Reports endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.pool = {};
  });

  it('returns compliance summary with sanitized params', async () => {
    complianceStore.summarizeCompliance.mockResolvedValue({
      summary: { approved: 42, rejected: 2, totalVerifications: 44, withinRange: 44 },
      rejectionReasons: [{ reason: 'Underage', count: 2 }],
      recentActivity: [
        {
          verificationId: 'ver-1',
          saleId: 'sale-1',
          clerkId: 'clerk-1',
          status: 'approved',
          reason: null,
          paymentType: 'cash',
          saleAmount: 12.34,
          saleStatus: 'completed',
          verifiedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          locationId: 'warehouse',
          outlet: { code: 'warehouse', label: 'Warehouse' },
          registerId: 'reg-1'
        }
      ],
      dailyStats: [
        {
          date: '2025-11-01',
          locationId: 'warehouse',
          totalVerifications: 10,
          approved: 9,
          rejected: 1,
          approvalRate: 90.0
        }
      ]
    });

    const res = await request(app)
      .get('/api/reports/compliance?days=15&limit=25')
      .expect(200);

    expect(complianceStore.summarizeCompliance).toHaveBeenCalledWith({
      days: 15,
      limit: 25
    });
    expect(res.body.data.summary.approved).toBe(42);
    expect(res.body.data.recentActivity[0].outlet.label).toBe('Warehouse');
  });

  it('returns override history from compliance store', async () => {
    complianceStore.listRecentOverrides.mockResolvedValue([
      {
        id: 'ovr-100',
        verificationId: 'ver-100',
        saleId: 'SALE-100',
        managerId: 'mgr-1',
        note: 'Manual review',
        createdAt: new Date().toISOString()
      }
    ]);

    const res = await request(app)
      .get('/api/reports/overrides?days=60&limit=10')
      .expect(200);

    expect(complianceStore.listRecentOverrides).toHaveBeenCalledWith({
      days: 60,
      limit: 10
    });
    expect(res.body.data[0].managerId).toBe('mgr-1');
  });

  it('handles override history errors gracefully', async () => {
    complianceStore.listRecentOverrides.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/api/reports/overrides').expect(500);

    expect(res.body.error).toBe('INTERNAL_ERROR');
    expect(complianceStore.listRecentOverrides).toHaveBeenCalled();
  });
});
