const logger = require('../src/logger');

describe('logger.logVerification', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('includes document metadata but omits sensitive numbers', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    logger.logVerification('SALE-55', 'clerk-9', true, 27, {
      documentType: 'passport',
      issuingCountry: 'CAN',
      documentNumber: 'X0000000'
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);

    const [logPayload, logMessage] = infoSpy.mock.calls[0];

    expect(logMessage).toMatch(/Verification APPROVED/);
    expect(logPayload).toMatchObject({
      event: 'verification_attempt',
      saleId: 'SALE-55',
      clerkId: 'clerk-9',
      documentType: 'passport',
      issuingCountry: 'CAN'
    });

    expect(logPayload.documentNumber).toBeUndefined();
  });
});
