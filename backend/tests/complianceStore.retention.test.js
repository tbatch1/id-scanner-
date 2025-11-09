"use strict";

jest.mock('../src/db', () => ({
  query: jest.fn(),
  pool: {}
}));

const db = require('../src/db');
const complianceStore = require('../src/complianceStore');

describe('complianceStore retention utilities', () => {
  beforeEach(() => {
    db.query.mockReset();
  });

  it('normalizes inputs for recent overrides listing', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'ovr-1' }] });

    const rows = await complianceStore.listRecentOverrides({ days: -5, limit: 5000 });

    expect(db.query).toHaveBeenCalledTimes(1);
    const args = db.query.mock.calls[0];
    expect(args[0]).toContain('verification_overrides');
    expect(args[1]).toEqual([30, 1000]);
    expect(rows).toHaveLength(1);
  });

  it('enforces retention windows with capped intervals', async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 4 }) // overrides
      .mockResolvedValueOnce({ rowCount: 3 }) // completions
      .mockResolvedValueOnce({ rowCount: 2 }); // verifications

    const result = await complianceStore.enforceRetention({
      verificationDays: 5000,
      overrideDays: 10,
      completionDays: 20
    });

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('verification_overrides'),
      [10]
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('sales_completions'),
      [20]
    );
    expect(db.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('verifications'),
      [3650]
    );

    expect(result).toEqual({
      overridesDeleted: 4,
      completionsDeleted: 3,
      verificationsDeleted: 2
    });
  });
});
