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

jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn()
  }
}));

const request = require('supertest');
const { app } = require('../src/app');
const db = require('../src/db');

describe('Admin Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.API_SECRET_KEY = '';
  });

  describe('GET /admin/pending/:locationId', () => {
    it('should return pending verifications for a location', async () => {
      const mockPendingScans = [
        {
          verification_id: 'VER123',
          sale_id: 'SALE123',
          first_name: 'John',
          last_name: 'Doe',
          age: 25,
          date_of_birth: '1998-01-01',
          status: 'rejected',
          reason: 'AGE_BELOW_21',
          document_type: 'drivers_license',
          location_id: 'heights',
          clerk_id: 'CLERK1',
          created_at: new Date().toISOString(),
          seconds_ago: 120
        }
      ];

      db.pool.query.mockResolvedValue({ rows: mockPendingScans });

      const res = await request(app)
        .get('/admin/pending/heights')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.location).toBe('heights');
      expect(res.body.count).toBe(1);
      expect(res.body.pending).toHaveLength(1);
      expect(res.body.pending[0].first_name).toBe('John');
      expect(res.body.pending[0].status).toBe('rejected');
    });

    it('should return empty array when no pending scans', async () => {
      db.pool.query.mockResolvedValue({ rows: [] });

      const res = await request(app)
        .get('/admin/pending/heights')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(0);
      expect(res.body.pending).toHaveLength(0);
    });

    it('should return 503 if database not configured', async () => {
      db.pool = null;

      const res = await request(app)
        .get('/admin/pending/heights')
        .expect(503);

      expect(res.body.error).toBe('DATABASE_UNAVAILABLE');

      // Restore pool for other tests
      db.pool = { query: jest.fn() };
    });

    it('should handle different location IDs', async () => {
      db.pool.query.mockResolvedValue({ rows: [] });

      await request(app)
        .get('/admin/pending/katy')
        .expect(200);

      expect(db.pool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['katy'])
      );
    });

    it('should only return rejected verifications not completed', async () => {
      db.pool.query.mockResolvedValue({ rows: [] });

      await request(app)
        .get('/admin/pending/heights')
        .expect(200);

      const query = db.pool.query.mock.calls[0][0];
      expect(query).toContain('status = \'rejected\'');
      expect(query).toContain('sc.id IS NULL');
    });
  });

  describe('GET /admin/scans - Pagination', () => {
    it('should return paginated scans with default limit', async () => {
      const mockScans = Array.from({ length: 100 }, (_, i) => ({
        verification_id: `VER${i}`,
        sale_id: `SALE${i}`,
        first_name: 'John',
        last_name: 'Doe',
        age: 25,
        date_of_birth: '1998-01-01',
        status: 'approved',
        reason: null,
        document_type: 'drivers_license',
        location_id: 'heights',
        clerk_id: 'CLERK1',
        created_at: new Date().toISOString()
      }));

      db.pool.query.mockResolvedValue({ rows: mockScans });

      const res = await request(app)
        .get('/admin/scans')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.scans).toHaveLength(100);
      expect(db.pool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([100, 0])
      );
    });

    it('should respect limit parameter', async () => {
      const mockScans = Array.from({ length: 50 }, (_, i) => ({
        verification_id: `VER${i}`,
        sale_id: `SALE${i}`,
        first_name: 'John',
        last_name: 'Doe',
        age: 25,
        status: 'approved',
        location_id: 'heights',
        clerk_id: 'CLERK1',
        created_at: new Date().toISOString()
      }));

      db.pool.query.mockResolvedValue({ rows: mockScans });

      const res = await request(app)
        .get('/admin/scans?limit=50')
        .expect(200);

      expect(res.body.scans).toHaveLength(50);
      expect(db.pool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([50, 0])
      );
    });

    it('should handle offset pagination correctly', async () => {
      const mockScans = Array.from({ length: 25 }, (_, i) => ({
        verification_id: `VER${i + 100}`,
        sale_id: `SALE${i + 100}`,
        first_name: 'John',
        last_name: 'Doe',
        age: 25,
        status: 'approved',
        location_id: 'heights',
        clerk_id: 'CLERK1',
        created_at: new Date().toISOString()
      }));

      db.pool.query.mockResolvedValue({ rows: mockScans });

      const res = await request(app)
        .get('/admin/scans?offset=100&limit=25')
        .expect(200);

      expect(res.body.scans).toHaveLength(25);
      expect(db.pool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([25, 100])
      );
    });

    it('should filter by location', async () => {
      db.pool.query.mockResolvedValue({ rows: [] });

      await request(app)
        .get('/admin/scans?location=heights')
        .expect(200);

      const query = db.pool.query.mock.calls[0][0];
      const params = db.pool.query.mock.calls[0][1];

      expect(query).toContain('location_id = $1');
      expect(params).toContain('heights');
    });

    it('should filter by status', async () => {
      db.pool.query.mockResolvedValue({ rows: [] });

      await request(app)
        .get('/admin/scans?status=approved')
        .expect(200);

      const params = db.pool.query.mock.calls[0][1];
      expect(params).toContain('approved');
    });

    it('should filter by both location and status', async () => {
      db.pool.query.mockResolvedValue({ rows: [] });

      await request(app)
        .get('/admin/scans?location=katy&status=rejected')
        .expect(200);

      const query = db.pool.query.mock.calls[0][0];
      const params = db.pool.query.mock.calls[0][1];

      expect(query).toContain('location_id = $1');
      expect(query).toContain('status = $2');
      expect(params).toContain('katy');
      expect(params).toContain('rejected');
    });

    it('should return 503 if database not configured', async () => {
      db.pool = null;

      const res = await request(app)
        .get('/admin/scans')
        .expect(503);

      expect(res.body.error).toBe('DATABASE_UNAVAILABLE');

      // Restore pool
      db.pool = { query: jest.fn() };
    });

    it('should handle large result sets efficiently', async () => {
      const mockScans = Array.from({ length: 500 }, (_, i) => ({
        verification_id: `VER${i}`,
        sale_id: `SALE${i}`,
        first_name: 'John',
        last_name: 'Doe',
        age: 25,
        status: 'approved',
        location_id: 'heights',
        clerk_id: 'CLERK1',
        created_at: new Date().toISOString()
      }));

      db.pool.query.mockResolvedValue({ rows: mockScans });

      const res = await request(app)
        .get('/admin/scans?limit=500')
        .expect(200);

      expect(res.body.scans).toHaveLength(500);
      expect(res.body.success).toBe(true);
    });

    it('should order scans by created_at DESC', async () => {
      db.pool.query.mockResolvedValue({ rows: [] });

      await request(app)
        .get('/admin/scans')
        .expect(200);

      const query = db.pool.query.mock.calls[0][0];
      expect(query).toContain('ORDER BY created_at DESC');
    });
  });

  describe('Admin Integration - Production Scenarios', () => {
    it('should handle multiple locations querying pending scans simultaneously', async () => {
      const locations = ['heights', 'katy', 'cypress', 'galleria', 'westheimer'];

      db.pool.query.mockResolvedValue({ rows: [] });

      const promises = locations.map(location =>
        request(app).get(`/admin/pending/${location}`)
      );

      const results = await Promise.all(promises);

      results.forEach((res, index) => {
        expect(res.status).toBe(200);
        expect(res.body.location).toBe(locations[index]);
      });

      expect(db.pool.query).toHaveBeenCalledTimes(5);
    });

    it('should handle pagination for 13 locations with 500+ scans per day', async () => {
      // Simulate a day's worth of scans across 13 locations
      const mockScans = Array.from({ length: 100 }, (_, i) => ({
        verification_id: `VER${i}`,
        sale_id: `SALE${i}`,
        first_name: 'Customer',
        last_name: `${i}`,
        age: 21 + (i % 30),
        status: i % 3 === 0 ? 'rejected' : 'approved',
        location_id: ['heights', 'katy', 'cypress'][i % 3],
        clerk_id: `CLERK${(i % 5) + 1}`,
        created_at: new Date(Date.now() - i * 1000 * 60).toISOString()
      }));

      db.pool.query.mockResolvedValue({ rows: mockScans });

      // Test pagination through large dataset
      const page1 = await request(app)
        .get('/admin/scans?limit=100&offset=0')
        .expect(200);

      expect(page1.body.scans).toHaveLength(100);

      const page2 = await request(app)
        .get('/admin/scans?limit=100&offset=100')
        .expect(200);

      expect(db.pool.query).toHaveBeenCalledTimes(2);
    });

    it('should support manager reviewing rejected scans by location', async () => {
      const rejectedScans = Array.from({ length: 5 }, (_, i) => ({
        verification_id: `VER${i}`,
        sale_id: `SALE${i}`,
        first_name: 'Rejected',
        last_name: 'Customer',
        age: 20,
        status: 'rejected',
        reason: 'AGE_BELOW_21',
        location_id: 'heights',
        clerk_id: 'CLERK1',
        created_at: new Date().toISOString(),
        seconds_ago: 300 + i * 60
      }));

      db.pool.query.mockResolvedValue({ rows: rejectedScans });

      const res = await request(app)
        .get('/admin/pending/heights')
        .expect(200);

      expect(res.body.pending).toHaveLength(5);
      res.body.pending.forEach(scan => {
        expect(scan.status).toBe('rejected');
        expect(scan.location_id).toBe('heights');
      });
    });
  });
});
