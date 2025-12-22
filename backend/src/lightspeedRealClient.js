const axios = require('axios');
const logger = require('./logger');

const PERSONAL_TOKEN = (process.env.LIGHTSPEED_API_KEY || '').trim();
const DOMAIN_PREFIX = (process.env.LIGHTSPEED_DOMAIN_PREFIX || process.env.LIGHTSPEED_ACCOUNT_ID || '').trim();
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
      note: sale.note || null,
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
    const response = await api.get(`/sales/${saleId}`);
    let currentNote = response?.data?.data?.note || '';

    // If a raw scan blob got pasted into Notes, strip it before appending our audit line.
    const ansiIndex = currentNote.indexOf('@ANSI');
    const aimIndex = currentNote.indexOf(']L');
    const markerIndex = ansiIndex >= 0 ? ansiIndex : (aimIndex >= 0 ? aimIndex : -1);
    if (markerIndex >= 0) {
      currentNote = currentNote.slice(0, markerIndex).trimEnd();
    }

    const timestamp = new Date().toLocaleString('en-US', { hour12: false });
    const status = verificationData.approved ? 'APPROVED' : 'REJECTED';
    const ageText = Number.isFinite(Number(verificationData.age)) ? `Age ${verificationData.age}` : 'Age unknown';
    const reason = !verificationData.approved && verificationData.reason ? ` (${verificationData.reason})` : '';
    const dobYear =
      typeof verificationData.dob === 'string' && verificationData.dob.length >= 4
        ? verificationData.dob.slice(0, 4)
        : null;
    const dobText = dobYear ? ` (DOB ${dobYear})` : '';

    const line = `ID Check ${status}: ${ageText}${dobText}${reason} — ${timestamp}`;
    const note = (currentNote ? `${currentNote}\n` : '') + line;

    // Keep note from growing unbounded.
    const capped = note.length > 1800 ? note.slice(note.length - 1800) : note;
    await api.put(`/sales/${saleId}`, { note: capped });
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

async function listSales({ status = 'OPEN', limit = 10, outletId = null } = {}) {
  try {
    const params = {
      page_size: Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 200)),
      ...(outletId ? { outlet_id: outletId } : {})
    };

    if (status) {
      params.status = status;
    }

    const response = await api.get('/sales', {
      params
    });
    const sales = response.data.data || [];
    return sales.map((sale) => ({
      saleId: sale.id,
      total: parseFloat(sale.total_price || 0),
      currency: 'USD',
      outletId: sale.outlet_id || null,
      registerId: sale.register_id || null,
      userId: sale.user_id || null,
      status: sale.status || null,
      note: sale.note || null,
      createdAt: sale.created_at || null,
      updatedAt: sale.updated_at || null
    }));
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
