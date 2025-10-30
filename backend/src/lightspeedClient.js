const axios = require('axios');
const config = require('./config');

const API_KEY = process.env.LIGHTSPEED_API_KEY;
const ACCOUNT_ID = process.env.LIGHTSPEED_ACCOUNT_ID;
const BASE_URL = `https://api.lightspeedapp.com/API/V3/Account/${ACCOUNT_ID}`;

// Check if credentials are configured
if (!API_KEY || !ACCOUNT_ID || API_KEY === 'your_api_key_here') {
  console.warn('⚠️  Lightspeed API credentials not configured. Using mock client.');
  module.exports = require('./mockLightspeedClient');
} else {
  console.log('✅ Lightspeed API credentials found. Using real client.');

  // Create axios instance with auth
  const lightspeedAPI = axios.create({
    baseURL: BASE_URL,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });

  // Cache for payment type IDs
  let paymentTypeCache = null;

  /**
   * Get payment type IDs (cash, card)
   */
  async function getPaymentTypes() {
    if (paymentTypeCache) return paymentTypeCache;

    try {
      const response = await lightspeedAPI.get('/PaymentType.json');
      const paymentTypes = response.data.PaymentType;

      paymentTypeCache = {
        cash: paymentTypes.find(pt => pt.type === 'cash')?.paymentTypeID,
        card: paymentTypes.find(pt => pt.type === 'credit card')?.paymentTypeID
      };

      console.log('💳 Payment types loaded:', paymentTypeCache);
      return paymentTypeCache;
    } catch (error) {
      console.error('❌ Error fetching payment types:', error.message);
      throw new Error('Unable to fetch payment types from Lightspeed');
    }
  }

  /**
   * Get sale by ID
   */
  async function getSaleById(saleId) {
    try {
      const response = await lightspeedAPI.get(`/Sale/${saleId}.json`);
      const sale = response.data.Sale;

      // Check if verification exists
      const verification = sale.note && sale.note.includes('ID Verified')
        ? {
            status: 'approved',
            verificationId: 'existing',
            createdAt: sale.updateTime || sale.createTime
          }
        : null;

      return {
        saleId: sale.saleID,
        total: parseFloat(sale.calcTotal),
        currency: 'USD',
        shopId: sale.shopID,
        registerId: sale.registerID,
        employeeId: sale.employeeID,
        customerId: sale.customerID,
        items: sale.SaleLines || [],
        verification,
        completed: sale.completed === 'true' || sale.completed === true
      };
    } catch (error) {
      console.error(`❌ Error fetching sale ${saleId}:`, error.message);
      if (error.response?.status === 404) {
        throw new Error('SALE_NOT_FOUND');
      }
      throw new Error('Unable to fetch sale from Lightspeed');
    }
  }

  /**
   * Record verification and complete sale
   */
  async function recordVerification({ saleId, clerkId, verificationData }) {
    try {
      const { approved, firstName, lastName, dob, age, reason } = verificationData;

      // Create verification record
      const verification = {
        verificationId: `VER-${Date.now()}`,
        saleId,
        clerkId,
        status: approved ? 'approved' : 'rejected',
        reason: reason || (approved ? 'Age verified - over 21' : 'Age verification failed - under 21'),
        firstName,
        lastName,
        dob,
        age,
        createdAt: new Date().toISOString()
      };

      // Update sale note with verification info
      const noteText = `ID Verified: ${firstName} ${lastName}, Age ${age}, ${new Date().toLocaleString()}`;

      await lightspeedAPI.put(`/Sale/${saleId}.json`, {
        Sale: {
          note: noteText
        }
      });

      console.log(`✅ Verification recorded for sale ${saleId}:`, verification.status);
      return verification;
    } catch (error) {
      console.error(`❌ Error recording verification for sale ${saleId}:`, error.message);
      throw new Error('Unable to record verification');
    }
  }

  /**
   * Complete sale with payment
   */
  async function completeSale({ saleId, verificationId, paymentType }) {
    try {
      // Get sale details to know the total
      const sale = await getSaleById(saleId);

      if (!sale) {
        throw new Error('SALE_NOT_FOUND');
      }

      if (sale.completed) {
        throw new Error('SALE_ALREADY_COMPLETED');
      }

      // Get payment type IDs
      const paymentTypes = await getPaymentTypes();
      const paymentTypeID = paymentTypes[paymentType]; // 'cash' or 'card'

      if (!paymentTypeID) {
        throw new Error(`Unknown payment type: ${paymentType}`);
      }

      // Complete sale with payment in one API call
      const response = await lightspeedAPI.put(`/Sale/${saleId}.json`, {
        Sale: {
          completed: true,
          completeTime: new Date().toISOString(),
          SalePayments: [
            {
              amount: sale.total.toFixed(2),
              paymentTypeID: paymentTypeID
            }
          ]
        }
      });

      console.log(`✅ Sale ${saleId} completed with ${paymentType} payment`);

      return {
        saleId,
        completedAt: new Date().toISOString(),
        paymentType,
        amount: sale.total,
        verificationId
      };
    } catch (error) {
      console.error(`❌ Error completing sale ${saleId}:`, error.message);

      if (error.message === 'SALE_NOT_FOUND') {
        throw error;
      }
      if (error.message === 'SALE_ALREADY_COMPLETED') {
        throw error;
      }

      throw new Error('Unable to complete sale in Lightspeed');
    }
  }

  /**
   * List all sales (for testing/debugging)
   */
  async function listSales() {
    try {
      const response = await lightspeedAPI.get('/Sale.json?limit=10');
      return response.data.Sale || [];
    } catch (error) {
      console.error('❌ Error listing sales:', error.message);
      return [];
    }
  }

  module.exports = {
    getSaleById,
    recordVerification,
    completeSale,
    listSales
  };
}
