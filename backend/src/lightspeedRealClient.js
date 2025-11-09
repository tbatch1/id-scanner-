const axios = require('axios');
const logger = require('./logger');

const PERSONAL_TOKEN = process.env.LIGHTSPEED_API_KEY;
const DOMAIN_PREFIX = process.env.LIGHTSPEED_DOMAIN_PREFIX || process.env.LIGHTSPEED_ACCOUNT_ID;
const BASE_URL = `https://${DOMAIN_PREFIX}.retail.lightspeed.app/api/2.0`;

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${PERSONAL_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 15000
});

async function getSaleById(saleId) {
  try {
    const response = await api.get(`/sales/${saleId}`);
    const sale = response.data.data;

    return {
      saleId: sale.id,
      total: parseFloat(sale.total_price || 0),
      currency: 'USD',
      outletId: sale.outlet_id,
      registerId: sale.register_id,
      userId: sale.user_id,
      customerId: sale.customer_id,
      items: sale.line_items || [],
      verification: null,
      status: sale.status,
      completed: sale.status === 'CLOSED'
    };
  } catch (error) {
    logger.error({ event: 'get_sale_failed', saleId, error: error.message });
    throw new Error('SALE_NOT_FOUND');
  }
}

async function recordVerification({ saleId, clerkId, verificationData }) {
  const verification = {
    verificationId: `VER-${Date.now()}`,
    saleId,
    clerkId,
    status: verificationData.approved ? 'approved' : 'rejected',
    ...verificationData,
    createdAt: new Date().toISOString()
  };

  try {
    const note = `ID Verified: ${verificationData.firstName} ${verificationData.lastName}, Age ${verificationData.age}`;
    await api.put(`/sales/${saleId}`, { note });
    logger.info({ event: 'verification_recorded', saleId });
  } catch (error) {
    logger.error({ event: 'record_verification_failed', saleId, error: error.message });
  }

  return verification;
}

async function completeSale({ saleId, verificationId, paymentType }) {
  try {
    const sale = await getSaleById(saleId);
    
    await api.put(`/sales/${saleId}`, { status: 'CLOSED' });
    
    logger.info({ event: 'sale_completed', saleId, paymentType });

    return {
      saleId,
      completedAt: new Date().toISOString(),
      paymentType,
      amount: sale.total,
      verificationId
    };
  } catch (error) {
    logger.error({ event: 'complete_sale_failed', saleId, error: error.message });
    throw error;
  }
}

async function listSales() {
  try {
    const response = await api.get('/sales', {
      params: { page_size: 10, status: 'OPEN' }
    });
    return response.data.data || [];
  } catch (error) {
    logger.error({ event: 'list_sales_failed', error: error.message });
    return [];
  }
}

module.exports = {
  getSaleById,
  recordVerification,
  completeSale,
  listSales
};
