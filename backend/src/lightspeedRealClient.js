const axios = require('axios');
const config = require('./config');
const logger = require('./logger');
const { appendAgeNote, buildAgeNoteLine } = require('./ageNote');
const oauth = require('./lightspeedOAuth');

const PERSONAL_TOKEN = (process.env.LIGHTSPEED_API_KEY || '').trim();
const DOMAIN_PREFIX = (process.env.LIGHTSPEED_DOMAIN_PREFIX || process.env.LIGHTSPEED_ACCOUNT_ID || '').trim();
const BASE_URL = `https://${DOMAIN_PREFIX}.retail.lightspeed.app/api/2.0`;

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: 7000 // Reduced from 15s to fit Vercel 10s Hobby limit
});

api.interceptors.request.use(async (requestConfig) => {
  const accessToken = await oauth.getAccessToken();
  const token = accessToken || PERSONAL_TOKEN;
  if (token) {
    requestConfig.headers = requestConfig.headers || {};
    requestConfig.headers.Authorization = `Bearer ${token}`;
  }
  return requestConfig;
});

const PRODUCT_CACHE_TTL_MS = Math.max(
  10_000,
  Math.min(24 * 60 * 60 * 1000, Number.parseInt(process.env.PRODUCT_CACHE_TTL_MS || '3600000', 10) || 3600000)
);

const productByIdCache = new Map();

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function fetchCollectionAllPages(path, params = {}, { pageSize = 200, maxPages = 50 } = {}) {
  const results = [];
  const normalizedPageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 200, 200));
  const normalizedMaxPages = Math.max(1, Math.min(Number.parseInt(maxPages, 10) || 50, 500));

  let after = params.after ? Number.parseInt(params.after, 10) : null;
  for (let page = 0; page < normalizedMaxPages; page += 1) {
    const nextParams = {
      ...params,
      page_size: normalizedPageSize,
      ...(Number.isFinite(after) && after !== null ? { after } : {})
    };

    const response = await api.get(path, { params: nextParams });
    const items = response.data.data || [];
    if (!items.length) break;

    results.push(...items);

    const versions = items
      .map((item) => (item && item.version !== undefined ? Number(item.version) : NaN))
      .filter((v) => Number.isFinite(v));
    const nextAfter = versions.length ? Math.max(...versions) : null;

    if (!Number.isFinite(nextAfter) || nextAfter === after) {
      break;
    }
    after = nextAfter;
  }

  return results;
}

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

    // Parallelize employee and outlet fetches
    let employeeName = null;
    let outletName = null;

    const [user, outlet] = await Promise.all([
      sale.user_id ? getUserById(sale.user_id) : Promise.resolve(null),
      sale.outlet_id ? getOutletById(sale.outlet_id) : Promise.resolve(null)
    ]);

    employeeName = user?.name || null;
    outletName = outlet?.label || null;

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

async function recordVerification({ saleId, clerkId, verificationData, sale: saleContext = null }) {
  const verification = {
    verificationId: `VER-${Date.now()}`,
    saleId,
    clerkId,
    status: verificationData.approved ? 'approved' : 'rejected',
    ...verificationData,
    createdAt: new Date().toISOString()
  };

  // Lightspeed's Sales endpoints are not guaranteed to support updates (and some accounts return 404/405 on write).
  // Detect this once and stop attempting so scans remain fast/reliable.
  if (recordVerification._saleNoteWriteSupported === false) {
    return { ...verification, noteUpdated: false };
  }

  let noteUpdated = false;
  try {
    // Only write Age note for successful verifications (approved). Rejections are tracked in our DB already.
    if (!verificationData.approved) {
      return { ...verification, noteUpdated };
    }

    let currentNote = typeof saleContext?.note === 'string' ? saleContext.note : '';
    if (!currentNote) {
      const response = await api.get(`/sales/${saleId}`);
      currentNote = response?.data?.data?.note || '';
    }

    const nextNote = appendAgeNote(currentNote, verificationData.age);

    // Keep note from growing unbounded.
    const capped = nextNote.length > 1800 ? nextNote.slice(nextNote.length - 1800) : nextNote;
    await api.put(`/sales/${saleId}`, { note: capped });
    noteUpdated = true;
    const ageLine = buildAgeNoteLine(verificationData.age) || null;
    logger.info({ event: 'verification_recorded', saleId, ageNote: ageLine });
  } catch (error) {
    const status = error?.response?.status || null;
    if (status === 404 || status === 405) {
      recordVerification._saleNoteWriteSupported = false;
      logger.warn(
        { event: 'record_verification_not_supported', saleId, status },
        'Lightspeed sale note write not supported; disabling further note attempts'
      );
    } else {
      logger.error({ event: 'record_verification_failed', saleId, status, error: error.message });
    }
  }

  return { ...verification, noteUpdated };
}

function normalizeStringValue(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

async function updateCustomerById(customerId, updates = {}, { fillBlanksOnly = true } = {}) {
  const id = String(customerId || '').trim();
  if (!id) {
    return { updated: false, customerId: null, fields: [], skipped: 'missing_customer_id' };
  }

  const writesEnabled = Boolean(config.lightspeed?.enableWrites);
  if (!writesEnabled) {
    return { updated: false, customerId: id, fields: [], skipped: 'writes_disabled' };
  }

  let existing = null;
  if (fillBlanksOnly) {
    try {
      const response = await api.get(`/customers/${encodeURIComponent(id)}`);
      const payload = response?.data?.data ?? response?.data ?? null;
      existing = Array.isArray(payload) ? payload[0] : payload;
    } catch (error) {
      logger.error({ event: 'get_customer_for_update_failed', customerId: id, error: error.message });
      existing = null;
    }
  }

  const payload = {};
  for (const [key, value] of Object.entries(updates || {})) {
    const normalized = normalizeStringValue(value);
    if (!normalized) continue;

    if (fillBlanksOnly && existing) {
      const current = normalizeStringValue(existing?.[key]);
      if (current) continue;
    }

    payload[key] = normalized;
  }

  const fields = Object.keys(payload);
  if (!fields.length) {
    return { updated: false, customerId: id, fields: [], skipped: fillBlanksOnly ? 'no_blank_fields' : 'no_fields' };
  }

  try {
    await api.put(`/customers/${encodeURIComponent(id)}`, payload);
    logger.info({ event: 'customer_updated_from_scan', customerId: id, fields });
    return { updated: true, customerId: id, fields };
  } catch (error) {
    const status = error?.response?.status || null;
    logger.error({ event: 'customer_update_failed', customerId: id, status, error: error.message, fields });
    return { updated: false, customerId: id, fields, status, error: error.message };
  }
}

async function completeSale({ saleId, verificationId, paymentType, sale: saleContext }) {
  try {
    const writesEnabled = Boolean(config.lightspeed?.enableWrites);
    const paymentTypeId = config.lightspeed?.paymentTypes?.[paymentType] || null;

    const sale = saleContext || (await getSaleById(saleId));
    const saleTotal = Number.isFinite(sale?.total) ? sale.total : 0;
    const normalizedTotal = Math.round(saleTotal * 100) / 100;

    if (writesEnabled && paymentTypeId) {
      await api.post(`/sales/${saleId}/payments`, {
        payment_type_id: paymentTypeId,
        amount: normalizedTotal,
        reference: verificationId
      });
      logger.info({ event: 'sale_payment_recorded', saleId, paymentType }, 'Recorded Lightspeed payment before closing sale');
    } else if (writesEnabled && !paymentTypeId) {
      logger.warn(
        { event: 'payment_type_not_configured', saleId, paymentType },
        'Writes enabled but payment type ID is missing; skipping payment creation'
      );
    }

    await api.put(`/sales/${saleId}`, { status: 'CLOSED' });

    logger.info({ event: 'sale_completed', saleId, paymentType });

    return {
      saleId,
      completedAt: new Date().toISOString(),
      paymentType,
      amount: normalizedTotal,
      verificationId
    };
  } catch (error) {
    logger.error({ event: 'complete_sale_failed', saleId, error: error.message });
    throw error;
  }
}

async function listSales({ status = 'OPEN', limit = 10, outletId = null, registerId = null } = {}) {
  try {
    const params = {
      page_size: Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 200)),
      ...(outletId ? { outlet_id: outletId } : {}),
      ...(registerId ? { register_id: registerId } : {})
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

function mapSaleWithLineItems(sale) {
  return {
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
      productName: item.product?.name || item.name || item.product_name || item.product_id || null,
      sku: item.product?.sku || item.sku || item.product_sku || null,
      quantity: parseFloat(item.quantity || 0),
      unitPrice: parseFloat(item.price || 0),
      lineTotal: parseFloat(item.total || item.price * item.quantity || 0)
    }))
  };
}

// List sales with full line item details (for snapshot aggregation)
async function listSalesWithLineItems({ status = 'CLOSED', limit = 200, outletId = null, dateFrom = null, dateTo = null, allPages = false } = {}) {
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

    let sales = [];
    if (allPages) {
      // For API 2.0, use cursor pagination (`after=<max version>`). `limit` here is treated as per-page size.
      sales = await fetchCollectionAllPages('/sales', params, { pageSize: params.page_size, maxPages: 200 });
    } else {
      const response = await api.get('/sales', { params });
      sales = response.data.data || [];
    }

    return sales.map(mapSaleWithLineItems);
  } catch (error) {
    logger.error({ event: 'list_sales_with_line_items_failed', error: error.message });
    return [];
  }
}

// Search sales by date range using the Search endpoint (recommended for date_from/date_to filtering).
async function searchSalesWithLineItems({
  outletId = null,
  state = 'CLOSED',
  dateFrom = null,
  dateTo = null,
  limit = 1000,
  silent = false
} = {}) {
  try {
    const pageLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 1000));
    const paramsBase = {
      type: 'sales',
      limit: pageLimit,
      page_size: pageLimit,
      ...(outletId ? { outlet_id: outletId } : {}),
      ...(state ? { status: state } : {}),
      ...(dateFrom ? { date_from: dateFrom } : {}),
      ...(dateTo ? { date_to: dateTo } : {})
    };

    const all = [];
    let skip = 0;
    for (let page = 0; page < 50; page += 1) {
      const response = await api.get('/search', { params: { ...paramsBase, skip } });
      const payload = response.data || {};
      const items = payload.data || payload.sales || payload.results || [];
      if (!Array.isArray(items) || items.length === 0) break;
      all.push(...items);
      if (items.length < pageLimit) break;
      skip += items.length;
    }

    return all.map(mapSaleWithLineItems);
  } catch (error) {
    logger.error({ event: 'search_sales_failed', error: error.message });
    if (silent) return [];
    throw error;
  }
}

async function searchSalesRaw({ outletId = null, limit = 10, skip = 0, state = null, dateFrom = null, dateTo = null } = {}) {
  const pageLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 1000));
  const normalizedSkip = Math.max(Number.parseInt(skip, 10) || 0, 0);

  const response = await api.get('/search', {
    params: {
      type: 'sales',
      limit: pageLimit,
      page_size: pageLimit,
      skip: normalizedSkip,
      ...(outletId ? { outlet_id: outletId } : {}),
      ...(state ? { status: state } : {}),
      ...(dateFrom ? { date_from: dateFrom } : {}),
      ...(dateTo ? { date_to: dateTo } : {})
    }
  });

  const payload = response.data || {};
  const items = payload.data || payload.sales || payload.results || [];
  return Array.isArray(items) ? items : [];
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

async function getProductById(productId, { useCache = true } = {}) {
  const normalizedId = productId ? String(productId).trim() : '';
  if (!normalizedId) return null;

  if (useCache) {
    const cached = cacheGet(productByIdCache, normalizedId);
    if (cached) return cached;
  }

  try {
    const response = await api.get(`/products/${encodeURIComponent(normalizedId)}`);
    const product = response.data?.data ?? response.data ?? null;
    if (!product || typeof product !== 'object') return null;

    const mapped = {
      productId: product.id || normalizedId,
      name: product.name || null,
      sku: product.sku || null,
      active: product.active ?? null,
      categoryId: product.product_category_id || product.category_id || null,
      categoryName: product.category?.name || product.product_category?.name || product.category_name || null,
      brandId: product.brand_id || null,
      brandName: product.brand?.name || null,
      supplierId: product.supplier_id || null,
      supplierName: product.supplier?.name || null,
      price: parseFloat(product.price || 0),
      supplyPrice: parseFloat(product.supply_price || 0),
      taxId: product.tax_id || null
    };

    cacheSet(productByIdCache, normalizedId, mapped, PRODUCT_CACHE_TTL_MS);
    return mapped;
  } catch (error) {
    logger.warn({ event: 'get_product_failed', productId: normalizedId, error: error.message });
    return null;
  }
}

// Get inventory levels by outlet
async function listInventory({ outletId = null, limit = 200, allPages = false } = {}) {
  try {
    const params = {
      page_size: Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 200)),
      ...(outletId ? { outlet_id: outletId } : {})
    };

    let inventory = [];
    if (allPages) {
      inventory = await fetchCollectionAllPages('/inventory', params, { pageSize: params.page_size, maxPages: 500 });
    } else {
      const response = await api.get('/inventory', { params });
      inventory = response.data.data || [];
    }

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
async function listCustomers({ limit = 200, email = null, allPages = false } = {}) {
  try {
    const params = {
      page_size: Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 200)),
      ...(email ? { email: email } : {})
    };

    let customers = [];
    if (allPages) {
      customers = await fetchCollectionAllPages('/customers', params, { pageSize: params.page_size, maxPages: 500 });
    } else {
      const response = await api.get('/customers', { params });
      customers = response.data.data || [];
    }

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
      createdAt: customer.created_at || null,
      updatedAt: customer.updated_at || null,
      version: customer.version ?? null
    }));
  } catch (error) {
    logger.error({ event: 'list_customers_failed', error: error.message });
    return [];
  }
}

// Raw customer listing for incremental sync (returns Lightspeed fields including `version`)
async function listCustomersRaw({ after = null, pageSize = 200, email = null } = {}) {
  const params = {
    page_size: Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 200, 200)),
    ...(email ? { email } : {}),
    ...(after !== null && after !== undefined && after !== '' ? { after } : {})
  };

  const response = await api.get('/customers', { params });
  return response.data.data || [];
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

async function getCustomerById(customerId) {
  const id = String(customerId || '').trim();
  if (!id) return null;

  try {
    const response = await api.get(`/customers/${encodeURIComponent(id)}`);
    const payload = response?.data?.data ?? response?.data ?? null;
    const customer = Array.isArray(payload) ? payload[0] : payload;
    if (!customer) return null;

    return {
      customerId: customer.id || id,
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
    };
  } catch (error) {
    logger.error({ event: 'get_customer_failed', customerId: id, error: error.message });
    return null;
  }
}

module.exports = {
  getSaleById,
  recordVerification,
  completeSale,
  listSales,
  listSalesWithLineItems,
  searchSalesWithLineItems,
  searchSalesRaw,
  listOutlets,
  listProducts,
  getProductById,
  listInventory,
  listCustomers,
  listCustomersRaw,
  getCustomerById,
  updateCustomerById,
  listCategories,
  listUsers,
  getUserById,
  getOutletById
};
