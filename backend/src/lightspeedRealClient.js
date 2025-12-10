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

async function getUserById(userId) {
  try {
    const response = await api.get(`/users/${userId}`);
    const user = response.data.data;

    return {
      userId: user.id,
      name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || null,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      email: user.email || null
    };
  } catch (error) {
    logger.warn({ event: 'get_user_failed', userId, error: error.message });
    return null;
  }
}

async function getOutletById(outletId) {
  try {
    const response = await api.get(`/outlets/${outletId}`);
    const outlet = response.data.data;

    return {
      outletId: outlet.id,
      name: outlet.name || null,
      code: outlet.code || null,
      label: outlet.name || outlet.code || null
    };
  } catch (error) {
    logger.warn({ event: 'get_outlet_failed', outletId, error: error.message });
    return null;
  }
}

async function getSaleById(saleId) {
  try {
    const response = await api.get(`/sales/${saleId}`);
    const sale = response.data.data;

    // Fetch employee/clerk name if user_id exists
    let employeeName = null;
    if (sale.user_id) {
      const user = await getUserById(sale.user_id);
      employeeName = user?.name || null;
    }

    // Fetch outlet/location name if outlet_id exists
    let outletName = null;
    if (sale.outlet_id) {
      const outlet = await getOutletById(sale.outlet_id);
      outletName = outlet?.label || null;
    }

    return {
      saleId: sale.id,
      total: parseFloat(sale.total_price || 0),
      currency: 'USD',
      outletId: sale.outlet_id,
      outletName: outletName,
      registerId: sale.register_id,
      userId: sale.user_id,
      employeeName: employeeName,
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

/**
 * Search for customers in Lightspeed by various criteria
 * @param {Object} searchCriteria - Search parameters
 * @param {string} searchCriteria.dlNumber - Driver's license number
 * @param {string} searchCriteria.firstName - First name
 * @param {string} searchCriteria.lastName - Last name
 * @param {string} searchCriteria.email - Email address
 * @param {string} searchCriteria.phone - Phone number
 * @returns {Promise<Array>} Array of matching customers
 */
async function searchCustomers({ dlNumber, firstName, lastName, email, phone }) {
  try {
    logger.info({
      event: 'searching_customers',
      criteria: { dlNumber, firstName, lastName, email, phone }
    });

    // Try searching by custom field (DL number) first if available
    if (dlNumber) {
      try {
        // Search by custom field - Lightspeed allows custom fields on customers
        const response = await api.get('/customers', {
          params: {
            'custom_field.dl_number': dlNumber,
            page_size: 10
          }
        });

        if (response.data.data && response.data.data.length > 0) {
          logger.info({
            event: 'customer_found_by_dl',
            count: response.data.data.length,
            customerId: response.data.data[0].id
          });
          return response.data.data;
        }
      } catch (dlError) {
        logger.debug({ event: 'dl_search_failed', error: dlError.message });
        // Continue to name search
      }
    }

    // Search by name if DL search didn't work
    if (firstName && lastName) {
      const response = await api.get('/customers', {
        params: {
          first_name: firstName,
          last_name: lastName,
          page_size: 10
        }
      });

      if (response.data.data && response.data.data.length > 0) {
        logger.info({
          event: 'customer_found_by_name',
          count: response.data.data.length,
          customerId: response.data.data[0].id
        });
        return response.data.data;
      }
    }

    // Try email search
    if (email) {
      const response = await api.get('/customers', {
        params: {
          email: email,
          page_size: 10
        }
      });

      if (response.data.data && response.data.data.length > 0) {
        logger.info({
          event: 'customer_found_by_email',
          count: response.data.data.length,
          customerId: response.data.data[0].id
        });
        return response.data.data;
      }
    }

    logger.info({ event: 'customer_not_found', criteria: { firstName, lastName, email } });
    return [];

  } catch (error) {
    logger.error({ event: 'search_customers_failed', error: error.message, stack: error.stack });
    return [];
  }
}

/**
 * Attach a customer to a sale for loyalty tracking
 * @param {string} saleId - The sale ID
 * @param {string} customerId - The customer ID
 * @returns {Promise<boolean>} Success status
 */
async function attachCustomerToSale(saleId, customerId) {
  try {
    logger.info({ event: 'attaching_customer_to_sale', saleId, customerId });

    // CRITICAL: Lightspeed API requires fetching the full sale first
    // Then POST it back with the customer_id added to /api/register_sales

    // Step 1: Get the current sale data
    const saleResponse = await api.get(`/sales/${saleId}`);
    const sale = saleResponse.data.data;

    logger.info({
      event: 'sale_fetched_for_update',
      saleId,
      currentCustomerId: sale.customer_id,
      newCustomerId: customerId
    });

    // Step 2: POST the sale back with customer_id using the v0.9 endpoint
    // Note: Lightspeed requires the ENTIRE sale object to be sent back
    const updatePayload = {
      id: sale.id,
      customer_id: customerId,
      outlet_id: sale.outlet_id,
      register_id: sale.register_id,
      user_id: sale.user_id,
      status: sale.status,
      // Include line items (required by API)
      register_sale_products: sale.line_items || [],
      // Include payments if present
      register_sale_payments: sale.register_sale_payments || [],
      // Include other critical fields
      sale_date: sale.sale_date,
      note: sale.note,
      total_price: sale.total_price,
      total_tax: sale.total_tax
    };

    // Use v0.9 endpoint for sale updates
    const updateResponse = await api.post('/register_sales', updatePayload);

    logger.info({
      event: 'customer_attached_success',
      saleId,
      customerId,
      msg: 'Customer linked to sale for loyalty tracking - will appear on iPad app'
    });

    return true;

  } catch (error) {
    logger.error({
      event: 'attach_customer_failed',
      saleId,
      customerId,
      error: error.message,
      response: error.response?.data,
      stack: error.stack
    });
    return false;
  }
}

module.exports = {
  getSaleById,
  recordVerification,
  completeSale,
  listSales,
  searchCustomers,
  attachCustomerToSale
};
