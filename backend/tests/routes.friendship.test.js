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
    findBannedCustomer: jest.fn()
}));

jest.mock('../src/db', () => ({
    pool: {},
    query: jest.fn(),
    testConnection: jest.fn().mockResolvedValue(true)
}));

const request = require('supertest');
const { app } = require('../src/app');
const saleVerificationStore = require('../src/saleVerificationStore');

describe('Friendship & Reliability API Endpoints', () => {
    const saleId = 'ROUTE-TEST-1';

    beforeEach(() => {
        saleVerificationStore.completeVerification(saleId);
    });

    it('should record a heartbeat from the handheld', async () => {
        saleVerificationStore.createVerification(saleId);

        const res = await request(app)
            .post(`/api/sales/${saleId}/heartbeat`)
            .expect(200);

        expect(res.body.success).toBe(true);

        const status = saleVerificationStore.getVerification(saleId);
        expect(status.remoteScannerActive).toBe(true);
    });

    it('should record a session-specific log from the handheld', async () => {
        saleVerificationStore.createVerification(saleId);

        await request(app)
            .post(`/api/sales/${saleId}/logs`)
            .send({ message: 'Handheld button pressed', type: 'info' })
            .expect(200);

        const status = saleVerificationStore.getVerification(saleId);
        expect(status.logs.some(l => l.m === 'Handheld button pressed')).toBe(true);
    });

    it('should return 404 for heartbeat on non-existent sale', async () => {
        await request(app)
            .post('/api/sales/NON-EXISTENT/heartbeat')
            .expect(404);
    });

    it('should include full friendship metadata in /status', async () => {
        saleVerificationStore.createVerification(saleId);
        saleVerificationStore.updateHeartbeat(saleId);
        saleVerificationStore.addSessionLog(saleId, 'Backend testing /status');

        const res = await request(app)
            .get(`/api/sales/${saleId}/status`)
            .expect(200);

        expect(res.body).toHaveProperty('remoteScannerActive', true);
        expect(res.body).toHaveProperty('logs');
        expect(res.body.logs.some(l => l.m === 'Backend testing /status')).toBe(true);
    });

    it('should return specific message for expired /status sessions', async () => {
        const res = await request(app)
            .get('/api/sales/EXPIRED-OR-NONE/status')
            .expect(404);

        expect(res.body.message).toContain('not found or expired');
    });
});
