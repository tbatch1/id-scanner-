"use strict";

jest.mock('axios', () => ({
  post: jest.fn(),
  create: jest.fn()
}));

let axios;

function buildHttpMock(responseData = {}) {
  const fn = jest.fn().mockResolvedValue({ data: responseData });
  fn.defaults = { headers: {} };
  return fn;
}

describe('lightspeedXSeriesClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    axios = require('axios');

    axios.post.mockReset();
    axios.create.mockReset();

    process.env.LIGHTSPEED_USE_MOCK = 'false';
    process.env.LIGHTSPEED_CLIENT_ID = 'client-id';
    process.env.LIGHTSPEED_CLIENT_SECRET = 'client-secret';
    process.env.LIGHTSPEED_REDIRECT_URI = 'https://example.com/callback';
    process.env.LIGHTSPEED_API_BASE_URL = 'https://example.vendhq.com/api/2.0';
    process.env.LIGHTSPEED_TOKEN_URL = 'https://auth.example.com/token';
    process.env.LIGHTSPEED_HTTP_TIMEOUT = '1000';
  });

  afterEach(() => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.keys(originalEnv).forEach((key) => {
      process.env[key] = originalEnv[key];
    });
  });

  test('getAuthState reflects missing refresh token', () => {
    const httpMock = buildHttpMock();
    axios.create.mockReturnValue(httpMock);

    const client = require('../src/lightspeedXSeriesClient');
    client.__resetAuthState();
    client.setRefreshToken(null);

    const state = client.getAuthState();
    expect(state.status).toBe('needs_login');
  });

  test('applyOAuthTokens updates auth state to ready', () => {
    const httpMock = buildHttpMock();
    axios.create.mockReturnValue(httpMock);

    const client = require('../src/lightspeedXSeriesClient');
    client.__resetAuthState();
    client.setRefreshToken('seed-refresh');

    client.applyOAuthTokens({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600
    });

    const state = client.getAuthState();
    expect(state.status).toBe('ready');
    expect(state.hasRefreshToken).toBe(true);
  });

  test('listSales triggers token refresh and authorized request', async () => {
    const httpMock = buildHttpMock({ register_sales: [] });
    axios.create.mockReturnValue(httpMock);

    axios.post.mockImplementation(() =>
      Promise.resolve({
        data: {
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 7200
        }
      })
    );

    const client = require('../src/lightspeedXSeriesClient');
    client.__resetAuthState();
    client.setRefreshToken('seed-refresh');

    await client.listSales();

    expect(axios.post).toHaveBeenCalledWith(
      'https://auth.example.com/token',
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' })
      })
    );

    expect(httpMock).toHaveBeenCalledTimes(1);
    const requestConfig = httpMock.mock.calls[0][0];
    expect(requestConfig.headers.Authorization).toBe('Bearer refreshed-access');
    expect(requestConfig.headers.Accept).toBe('application/json');
    expect(requestConfig.url).toBe('/register_sales');
  });

  test('recordVerification posts Lightspeed note when writes enabled', async () => {
    process.env.LIGHTSPEED_ENABLE_WRITE = 'true';
    process.env.LIGHTSPEED_PAYMENT_TYPE_ID_CASH = 'pay-cash';

    const httpMock = buildHttpMock({});
    axios.create.mockReturnValue(httpMock);

    const client = require('../src/lightspeedXSeriesClient');
    client.__resetAuthState();
    client.applyOAuthTokens({
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresIn: 3600
    });

    await client.recordVerification({
      saleId: 'SALE-1',
      clerkId: 'clerk-1',
      verificationData: {
        approved: true,
        firstName: 'Test',
        lastName: 'User',
        documentType: 'drivers_license',
        documentNumber: 'ABC123',
        source: 'pdf417'
      },
      sale: { registerId: 'REG-1' },
      locationId: 'warehouse'
    });

    const noteCall = httpMock.mock.calls.find(
      ([config]) => config && typeof config.url === 'string' && config.url.includes('/notes')
    );
    expect(noteCall).toBeDefined();
    expect(noteCall[0].data.note).toContain('Verification APPROVED');
    expect(noteCall[0].data.note).toContain('Location: warehouse');
  });

  test('completeSale posts Lightspeed payment when writes enabled', async () => {
    process.env.LIGHTSPEED_ENABLE_WRITE = 'true';
    process.env.LIGHTSPEED_PAYMENT_TYPE_ID_CASH = 'pay-cash';

    const httpMock = buildHttpMock({});
    axios.create.mockReturnValue(httpMock);

    const client = require('../src/lightspeedXSeriesClient');
    client.__resetAuthState();
    client.applyOAuthTokens({
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresIn: 3600
    });

    await client.completeSale({
      saleId: 'SALE-2',
      verificationId: 'VER-2',
      paymentType: 'cash',
      sale: { total: 88.5 },
      locationId: 'warehouse'
    });

    const paymentCall = httpMock.mock.calls.find(
      ([config]) => config && typeof config.url === 'string' && config.url.includes('/payments')
    );
    expect(paymentCall).toBeDefined();
    expect(paymentCall[0].data.payment_type_id).toBe('pay-cash');
    expect(paymentCall[0].data.amount).toBe(88.5);
    expect(paymentCall[0].data.reference).toBe('VER-2');
  });
});
