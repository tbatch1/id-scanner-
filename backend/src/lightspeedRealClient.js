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

    const line = `ID Verified ${status}: ${ageText}${dobText}${reason} — ${timestamp}`;
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
      customerId: sale.customer_id || null,
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

// List sales with full line item details (for snapshot aggregation)
async function listSalesWithLineItems({ status = 'CLOSED', limit = 200, outletId = null, dateFrom = null, dateTo = null } = {}) {
  try {
    const params = {
      page_size: Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 200)),
      ...(outletId ? { outlet_id: outletId } : {}),
      ...(dateFrom ? { date_from: dateFrom } : {}),
      ...(dateTo ? { date_to: dateTo } : {})
    };

    if (status) {
      params.status = status;
    }

    const response = await api.get('/sales', { params });
    const sales = response.data.data || [];

    return sales.map((sale) => ({
      saleId: sale.id,
      total: parseFloat(sale.total_price || 0),
      totalTax: parseFloat(sale.total_tax || 0),
      outletId: sale.outlet_id || null,
      registerId: sale.register_id || null,
      userId: sale.user_id || null,
      customerId: sale.customer_id || null,
      status: sale.status || null,
      saleDate: sale.sale_date || sale.created_at || null,
      lineItems: (sale.line_items || []).map((item) => ({
        productId: item.product_id || null,
        productName: item.product?.name || item.name || null,
        sku: item.product?.sku || item.sku || null,
        quantity: parseFloat(item.quantity || 0),
        unitPrice: parseFloat(item.price || 0),
        lineTotal: parseFloat(item.total || item.price * item.quantity || 0)
      }))
    }));
  } catch (error) {
    logger.error({ event: 'list_sales_with_line_items_failed', error: error.message });
    return [];
  }
}

// List all outlets
async function listOutlets() {
  try {
    const response = await api.get('/outlets');
    const outlets = response.data.data || [];
    return outlets.map((outlet) => ({
      outletId: outlet.id,
      name: outlet.name || null,
      code: outlet.code || null,
      label: outlet.name || outlet.code || outlet.id,
      currency: outlet.currency || 'USD',
      timezone: outlet.time_zone || null
    }));
  } catch (error) {
    logger.error({ event: 'list_outlets_failed', error: error.message });
    return [];
  }
}

// List products with optional filters
async function listProducts({ limit = 200, active = true, categoryId = null } = {}) {
  try {
    const params = {
      page_size: Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 200)),
      ...(active !== null ? { active: active } : {}),
      ...(categoryId ? { category_id: categoryId } : {})
    };

    const response = await api.get('/products', { params });
    const products = response.data.data || [];

    return products.map((product) => ({
      productId: product.id,
      name: product.name || null,
      sku: product.sku || null,
      description: product.description || null,
      active: product.active ?? true,
      brandId: product.brand_id || null,
      brandName: product.brand?.name || null,
      categoryId: product.product_category_id || null,
      categoryName: product.category?.name || null,
      supplierId: product.supplier_id || null,
      supplierName: product.supplier?.name || null,
      price: parseFloat(product.price || 0),
      supplyPrice: parseFloat(product.supply_price || 0),
      taxId: product.tax_id || null
    }));
  } catch (error) {
    logger.error({ event: 'list_products_failed', error: error.message });
    return [];
  }
}

// Get inventory levels by outlet
async function listInventory({ outletId = null, limit = 200 } = {}) {
  try {
    const params = {
      page_size: Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 200)),
      ...(outletId ? { outlet_id: outletId } : {})
    };

    const response = await api.get('/inventory', { params });
    const inventory = response.data.data || [];

    return inventory.map((item) => ({
      productId: item.product_id || null,
      productName: item.product?.name || null,
      sku: item.product?.sku || null,
      outletId: item.outlet_id || null,
      currentAmount: parseFloat(item.current_amount || 0),
      reorderPoint: parseFloat(item.reorder_point || 0),
      reorderAmount: parseFloat(item.reorder_amount || 0),
      averageCost: parseFloat(item.average_cost || 0),
      retailPrice: parseFloat(item.product?.price || 0)
    }));
  } catch (error) {
    logger.error({ event: 'list_inventory_failed', error: error.message });
    return [];
  }
}

// List customers with optional filters
async function listCustomers({ limit = 200, email = null } = {}) {
  try {
    const params = {
      page_size: Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 200)),
      ...(email ? { email: email } : {})
    };

    const response = await api.get('/customers', { params });
    const customers = response.data.data || [];

    return customers.map((customer) => ({
      customerId: customer.id,
      name: customer.name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || null,
      firstName: customer.first_name || null,
      lastName: customer.last_name || null,
      email: customer.email || null,
      phone: customer.phone || null,
      customerGroupId: customer.customer_group_id || null,
      yearToDate: parseFloat(customer.year_to_date || 0),
      balance: parseFloat(customer.balance || 0),
      loyaltyBalance: parseFloat(customer.loyalty_balance || 0),
      createdAt: customer.created_at || null
    }));
  } catch (error) {
    logger.error({ event: 'list_customers_failed', error: error.message });
    return [];
  }
}

// Get product categories
async function listCategories() {
  try {
    const response = await api.get('/product-categories');
    const categories = response.data.data || [];

    return categories.map((cat) => ({
      categoryId: cat.id,
      name: cat.name || null,
      parentId: cat.parent_id || null
    }));
  } catch (error) {
    logger.error({ event: 'list_categories_failed', error: error.message });
    return [];
  }
}

// List all users (employees)
async function listUsers() {
  try {
    const response = await api.get('/users');
    const users = response.data.data || [];

    return users.map((user) => ({
      userId: user.id,
      name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || null,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      email: user.email || null,
      username: user.username || null
    }));
  } catch (error) {
    logger.error({ event: 'list_users_failed', error: error.message });
    return [];
  }
}

module.exports = {
  getSaleById,
  recordVerification,
  completeSale,
  listSales,
  listSalesWithLineItems,
  listOutlets,
  listProducts,
  listInventory,
  listCustomers,
  listCategories,
  listUsers,
  getUserById,
  getOutletById
};
