const saleVerificationStore = require('../src/saleVerificationStore');

describe('saleVerificationStore Friendship Logic', () => {
    const saleId = 'TEST-SALE-1';

    beforeEach(() => {
        // Clean up store before each test
        saleVerificationStore.completeVerification(saleId);
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should initialize a session with friendship defaults', () => {
        const verification = saleVerificationStore.createVerification(saleId);
        expect(verification.remoteScannerActive).toBe(false);
        expect(verification.lastHeartbeat).toBe(null);
        expect(verification.logs.length).toBe(1);
        expect(verification.logs[0].m).toContain('Waiting for handheld');
    });

    it('should update heartbeat and set active state', () => {
        saleVerificationStore.createVerification(saleId);
        const updated = saleVerificationStore.updateHeartbeat(saleId);

        expect(updated.remoteScannerActive).toBe(true);
        expect(updated.lastHeartbeat).toBeInstanceOf(Date);
        expect(updated.logs.some(l => l.m.includes('Handheld scanner connected'))).toBe(true);
    });

    it('should add session logs correctly', () => {
        saleVerificationStore.createVerification(saleId);
        saleVerificationStore.addSessionLog(saleId, 'Testing log message', 'info');

        const verification = saleVerificationStore.getVerification(saleId);
        expect(verification.logs.some(l => l.m === 'Testing log message')).toBe(true);
    });

    it('should cap logs at 50 entries', () => {
        saleVerificationStore.createVerification(saleId);
        for (let i = 0; i < 60; i++) {
            saleVerificationStore.addSessionLog(saleId, `Log ${i}`);
        }

        const verification = saleVerificationStore.getVerification(saleId);
        expect(verification.logs.length).toBe(50);
    });

    it('should transition to inactive if heartbeat is old (Friendship Auto-Detect)', () => {
        saleVerificationStore.createVerification(saleId);
        saleVerificationStore.updateHeartbeat(saleId);

        let verification = saleVerificationStore.getVerification(saleId);
        expect(verification.remoteScannerActive).toBe(true);

        // Fast forward 11 seconds
        jest.advanceTimersByTime(11000);

        // Trigger auto-detect via getVerification
        verification = saleVerificationStore.getVerification(saleId);
        expect(verification.remoteScannerActive).toBe(false);
        expect(verification.logs.some(l => l.m.includes('Handheld scanner timed out'))).toBe(true);
    });

    it('should include friendship data in getVerification result', () => {
        saleVerificationStore.createVerification(saleId);
        saleVerificationStore.updateHeartbeat(saleId);
        saleVerificationStore.addSessionLog(saleId, 'Scan started');

        const status = saleVerificationStore.getVerification(saleId);
        expect(status).toHaveProperty('remoteScannerActive', true);
        expect(status).toHaveProperty('logs');
        expect(status.logs.length).toBeGreaterThan(1);
    });
});
