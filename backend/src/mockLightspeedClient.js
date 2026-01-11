// Mock Lightspeed Client - Used when API credentials are not configured

const config = require('./config');
const { appendAgeNote } = require('./ageNote');

const saleStore = new Map();
const verificationStore = new Map();

function seedSales() {
  if (saleStore.size > 0) {
    return;
  }

  const now = new Date().toISOString();
  const sampleSales = [
    {
      saleID: 'SALE-1001',
      reference: 'Walk-in',
      total: 12.99,
      currency: 'USD',
      note: '',
      items: [
        {
          saleLineID: 'LINE-1',
          description: 'THC Club House Preroll 1g',
          quantity: 1,
          price: 12.99
        }
      ],
      customer: null,
      employeeName: 'John Smith',
      outletName: 'Westheimer',
      status: 'awaiting_verification',
      createdAt: now,
      updatedAt: now,
      lastVerificationId: null
    },
    {
      saleID: 'SALE-1002',
      reference: 'Curbside Pickup',
      total: 87.48,
      currency: 'USD',
      note: '',
      items: [
        {
          saleLineID: 'LINE-1',
          description: 'Infused Gummies 10-pack',
          quantity: 2,
          price: 19.75
        },
        {
          saleLineID: 'LINE-2',
          description: 'Premium Flower 3.5g',
          quantity: 1,
          price: 47.98
        },
        {
          saleLineID: 'LINE-3',
          description: 'Vape Cartridge 1g',
          quantity: 1,
          price: 0.00
        }
      ],
      customer: {
        firstName: 'Alex',
        lastName: 'Rivera',
        dob: '1998-05-12'
      },
      employeeName: 'Sarah Johnson',
      outletName: 'Galleria',
      status: 'awaiting_verification',
      createdAt: now,
      updatedAt: now,
      lastVerificationId: null
    }
  ];

  sampleSales.forEach((sale) => {
    saleStore.set(sale.saleID, sale);
  });
}

seedSales();

function listVerifications({ location, status, limit = 100, offset = 0 } = {}) {
  const normalizedLimit = Math.max(0, Number.parseInt(limit, 10) || 0);
  const normalizedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);

  const rows = Array.from(verificationStore.values())
    .filter((record) => {
      if (location && record.locationId !== location) return false;
      if (status && record.status !== status) return false;
      return true;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((record) => ({
      verification_id: record.verificationId,
      sale_id: record.saleId,
      first_name: record.firstName,
      last_name: record.lastName,
      age: record.age,
      date_of_birth: record.dob,
      status: record.status,
      reason: record.reason,
      document_type: record.documentType || 'drivers_license',
      location_id: record.locationId,
      clerk_id: record.clerkId,
      created_at: record.createdAt,
      source: record.source || 'pdf417'
    }));

  return rows.slice(normalizedOffset, normalizedOffset + normalizedLimit);
}

function getSaleById(saleId) {
  const sale = saleStore.get(saleId);
  if (!sale) {
    return null;
  }

  const verification = sale.lastVerificationId
    ? verificationStore.get(sale.lastVerificationId) || null
    : null;
  const verificationExpired =
    verification && verification.createdAt
      ? Date.now() - new Date(verification.createdAt).getTime() >
        config.verificationExpiryMinutes * 60 * 1000
      : null;

  const outletId = sale.outletId || config.lightspeed?.defaultOutletId || null;
  let outletDescriptor = null;
  if (outletId) {
    outletDescriptor =
      (config.lightspeed?.outletsById && config.lightspeed.outletsById[outletId]) || {
        id: outletId,
        code: null,
        label: outletId === config.lightspeed?.defaultOutletId ? 'Default Outlet' : null
      };
  }

  return {
    saleId: sale.saleID,
    reference: sale.reference,
    total: sale.total,
    currency: sale.currency,
    note: sale.note || null,
    items: sale.items,
    verification,
    completed: sale.status === 'completed',
    status: sale.status,
    verificationExpired,
    registerId: sale.registerId || null,
    outletId,
    outlet: outletDescriptor
  };
}

function recordVerification({ saleId, clerkId, verificationData, sale: saleContext, locationId }) {
  const storedSale = saleStore.get(saleId);
  if (!storedSale) {
    throw new Error('SALE_NOT_FOUND');
  }

  const verificationId = `VER-${Date.now()}`;
  const timestamp = new Date().toISOString();
  const effectiveLocationId =
    locationId ||
    saleContext?.outletId ||
    storedSale.outletId ||
    config.lightspeed?.defaultOutletId ||
    null;

  const record = {
    verificationId,
    saleId,
    clerkId,
    status: verificationData.approved ? 'approved' : 'rejected',
    reason: verificationData.approved ? null : verificationData.reason || 'Underage or invalid ID',
    firstName: verificationData.firstName || null,
    lastName: verificationData.lastName || null,
    middleName: verificationData.middleName || null,
    dob: verificationData.dob || null,
    age: verificationData.age || null,
    documentType: verificationData.documentType || null,
    documentNumber: verificationData.documentNumber || null,
    issuingCountry: verificationData.issuingCountry || null,
    nationality: verificationData.nationality || null,
    documentExpiry: verificationData.documentExpiry || null,
    sex: verificationData.sex || null,
    source: verificationData.source || 'pdf417',
    locationId: effectiveLocationId,
    registerId: saleContext?.registerId || storedSale.registerId || null,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  verificationStore.set(verificationId, record);

  storedSale.lastVerificationId = verificationId;
  storedSale.status = verificationData.approved ? 'verified' : 'awaiting_verification';
  let noteUpdated = false;
  if (verificationData.approved) {
    storedSale.note = appendAgeNote(storedSale.note || '', verificationData.age);
    noteUpdated = true;
  }
  storedSale.updatedAt = timestamp;

  saleStore.set(saleId, storedSale);

  return { ...record, noteUpdated };
}

function completeSale({ saleId, verificationId, paymentType, sale: saleContext, locationId }) {
  const storedSale = saleStore.get(saleId);
  if (!storedSale) {
    throw new Error('SALE_NOT_FOUND');
  }

  if (!verificationId || !verificationStore.has(verificationId)) {
    throw new Error('VERIFICATION_NOT_FOUND');
  }

  const verification = verificationStore.get(verificationId);
  if (verification.status !== 'approved') {
    throw new Error('VERIFICATION_NOT_APPROVED');
  }

  const timestamp = new Date().toISOString();
  const effectiveLocationId =
    locationId ||
    saleContext?.outletId ||
    storedSale.outletId ||
    config.lightspeed?.defaultOutletId ||
    null;

  storedSale.status = 'completed';
  storedSale.updatedAt = timestamp;
  storedSale.completion = {
    verificationId,
    completedAt: timestamp,
    paymentType: paymentType || 'cash'
  };

  saleStore.set(saleId, storedSale);

  return {
    saleId,
    completedAt: timestamp,
    paymentType: paymentType || 'cash',
    amount: storedSale.total,
    verificationId,
    locationId: effectiveLocationId
  };
}

function listSales({ status, limit = 50 } = {}) {
  const normalizedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
  const rows = Array.from(saleStore.values())
    .filter((sale) => {
      if (!status) return true;
      const normalizedStatus = String(status).toUpperCase();
      if (normalizedStatus === 'OPEN') return sale.status !== 'completed';
      if (normalizedStatus === 'CLOSED') return sale.status === 'completed';
      return true;
    })
    .slice(0, normalizedLimit)
    .map((sale) => getSaleById(sale.saleID));

  return rows;
}

function getComplianceReport() {
  const allSales = listSales();
  const totalSales = allSales.length;
  const awaitingVerification = allSales.filter((sale) => sale.status === 'awaiting_verification').length;
  const verified = allSales.filter((sale) => sale.status === 'verified').length;
  const completed = allSales.filter((sale) => sale.status === 'completed').length;
  const allVerifications = Array.from(verificationStore.values());
  const approved = allVerifications.filter((v) => v.status === 'approved').length;
  const rejected = allVerifications.filter((v) => v.status === 'rejected').length;
  const rejectionReasons = allVerifications
    .filter((v) => v.status === 'rejected')
    .reduce((acc, v) => {
      const reason = v.reason || 'Unspecified';
      acc[reason] = (acc[reason] || 0) + 1;
      return acc;
    }, {});

  return Promise.resolve({
    summary: {
      totalSales,
      awaitingVerification,
      verified,
      completed
    },
    verifications: {
      total: allVerifications.length,
      approved,
      rejected,
      withinRange: allVerifications.length
    },
    rejectionReasons: Object.entries(rejectionReasons).map(([reason, count]) => ({
      reason,
      count
    })),
    recentVerifications: allVerifications
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .map((v) => ({
        verificationId: v.verificationId,
        saleId: v.saleId,
        clerkId: v.clerkId,
        status: v.status,
        reason: v.reason,
        firstName: v.firstName,
        lastName: v.lastName,
        dob: v.dob,
        age: v.age,
        createdAt: v.createdAt
      }))
  });
}

function getAuthState() {
  return {
    status: 'mock',
    hasRefreshToken: true,
    accessTokenExpiresAt: null
  };
}

// Mock data for BI features
const mockOutlets = [
  { outletId: 'OUTLET-001', name: 'Westheimer', code: 'WH', label: 'Westheimer', currency: 'USD', timezone: 'America/Chicago' },
  { outletId: 'OUTLET-002', name: 'Galleria', code: 'GA', label: 'Galleria', currency: 'USD', timezone: 'America/Chicago' }
];

const mockProducts = [
  { productId: 'PROD-001', name: 'THC Club House Preroll 1g', sku: 'PRE-001', price: 12.99, categoryName: 'Prerolls', active: true },
  { productId: 'PROD-002', name: 'Infused Gummies 10-pack', sku: 'GUM-001', price: 19.75, categoryName: 'Edibles', active: true },
  { productId: 'PROD-003', name: 'Premium Flower 3.5g', sku: 'FLW-001', price: 47.98, categoryName: 'Flower', active: true },
  { productId: 'PROD-004', name: 'Vape Cartridge 1g', sku: 'VAP-001', price: 35.00, categoryName: 'Vapes', active: true },
  { productId: 'PROD-005', name: 'CBD Tincture 30ml', sku: 'TNC-001', price: 29.99, categoryName: 'Tinctures', active: true }
];

const mockInventory = [
  { productId: 'PROD-001', productName: 'THC Club House Preroll 1g', sku: 'PRE-001', outletId: 'OUTLET-001', currentAmount: 45, reorderPoint: 20, averageCost: 6.50, retailPrice: 12.99 },
  { productId: 'PROD-002', productName: 'Infused Gummies 10-pack', sku: 'GUM-001', outletId: 'OUTLET-001', currentAmount: 8, reorderPoint: 15, averageCost: 9.00, retailPrice: 19.75 },
  { productId: 'PROD-003', productName: 'Premium Flower 3.5g', sku: 'FLW-001', outletId: 'OUTLET-001', currentAmount: 22, reorderPoint: 10, averageCost: 22.00, retailPrice: 47.98 },
  { productId: 'PROD-004', productName: 'Vape Cartridge 1g', sku: 'VAP-001', outletId: 'OUTLET-001', currentAmount: 3, reorderPoint: 10, averageCost: 15.00, retailPrice: 35.00 },
  { productId: 'PROD-005', productName: 'CBD Tincture 30ml', sku: 'TNC-001', outletId: 'OUTLET-001', currentAmount: 18, reorderPoint: 8, averageCost: 12.00, retailPrice: 29.99 },
  { productId: 'PROD-001', productName: 'THC Club House Preroll 1g', sku: 'PRE-001', outletId: 'OUTLET-002', currentAmount: 32, reorderPoint: 20, averageCost: 6.50, retailPrice: 12.99 },
  { productId: 'PROD-002', productName: 'Infused Gummies 10-pack', sku: 'GUM-001', outletId: 'OUTLET-002', currentAmount: 25, reorderPoint: 15, averageCost: 9.00, retailPrice: 19.75 },
  { productId: 'PROD-003', productName: 'Premium Flower 3.5g', sku: 'FLW-001', outletId: 'OUTLET-002', currentAmount: 15, reorderPoint: 10, averageCost: 22.00, retailPrice: 47.98 }
];

const mockCustomers = [
  {
    customerId: 'CUST-001',
    name: 'Alex Rivera',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex@example.com',
    yearToDate: 1250.0,
    loyaltyBalance: 125,
    version: 10,
    dateOfBirth: '1990-06-15',
    sex: 'M',
    physical_postcode: '78701',
    physical_city: 'Austin',
    enable_loyalty: true
  },
  {
    customerId: 'CUST-002',
    name: 'Jordan Lee',
    firstName: 'Jordan',
    lastName: 'Lee',
    email: 'jordan@example.com',
    yearToDate: 890.5,
    loyaltyBalance: 89,
    version: 11,
    dateOfBirth: '1987-12-02',
    sex: 'F',
    physical_postcode: '78702',
    physical_city: 'Austin',
    enable_loyalty: true
  },
  {
    customerId: 'CUST-003',
    name: 'Sam Chen',
    firstName: 'Sam',
    lastName: 'Chen',
    email: 'sam@example.com',
    yearToDate: 2100.0,
    loyaltyBalance: 210,
    version: 12,
    dateOfBirth: '2001-01-10',
    sex: 'X',
    physical_postcode: '75001',
    physical_city: 'Dallas',
    enable_loyalty: false
  }
];

const mockUsers = [
  { userId: 'USER-001', name: 'John Smith', firstName: 'John', lastName: 'Smith', email: 'john@store.com', username: 'jsmith' },
  { userId: 'USER-002', name: 'Sarah Johnson', firstName: 'Sarah', lastName: 'Johnson', email: 'sarah@store.com', username: 'sjohnson' }
];

function listOutlets() {
  return mockOutlets;
}

function listProducts({ limit = 200, active = true } = {}) {
  let products = mockProducts;
  if (active !== null) {
    products = products.filter(p => p.active === active);
  }
  return products.slice(0, limit);
}

function getProductById(productId) {
  const id = String(productId || '').trim();
  if (!id) return null;
  const product = mockProducts.find((p) => p.productId === id) || null;
  if (!product) return null;
  return {
    productId: product.productId,
    name: product.name || null,
    sku: product.sku || null,
    categoryName: product.categoryName || null,
    active: product.active ?? true,
    price: parseFloat(product.price || 0)
  };
}

function listInventory({ outletId = null, limit = 200 } = {}) {
  let inventory = mockInventory;
  if (outletId) {
    inventory = inventory.filter(i => i.outletId === outletId);
  }
  return inventory.slice(0, limit);
}

function listCustomers({ limit = 200 } = {}) {
  return mockCustomers.slice(0, limit);
}

function listCustomersRaw({ after = null, pageSize = 200 } = {}) {
  const normalizedAfter = after === null || after === undefined ? null : Number(after);
  const normalizedPageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 200, 200));

  const filtered = normalizedAfter === null
    ? mockCustomers
    : mockCustomers.filter((c) => Number(c.version || 0) > normalizedAfter);

  return filtered.slice(0, normalizedPageSize).map((c) => ({
    id: c.customerId,
    name: c.name,
    first_name: c.firstName,
    last_name: c.lastName,
    email: c.email,
    enable_loyalty: c.enable_loyalty ?? null,
    date_of_birth: c.dateOfBirth ?? null,
    sex: c.sex ?? null,
    physical_postcode: c.physical_postcode ?? null,
    physical_city: c.physical_city ?? null,
    loyalty_balance: c.loyaltyBalance ?? null,
    year_to_date: c.yearToDate ?? null,
    version: c.version ?? null,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    updated_at: new Date().toISOString()
  }));
}

function getCustomerById(customerId) {
  const id = String(customerId || '').trim();
  if (!id) return null;
  const found = mockCustomers.find((c) => String(c.customerId) === id) || null;
  return found || { customerId: id, name: `Customer ${id}`, email: null };
}

function updateCustomerById(customerId, updates = {}, { fillBlanksOnly = true } = {}) {
  return {
    updated: false,
    customerId: customerId ? String(customerId) : null,
    fields: Object.keys(updates || {}),
    skipped: 'mock_client'
  };
}

function listUsers() {
  return mockUsers;
}

function listCategories() {
  return [
    { categoryId: 'CAT-001', name: 'Prerolls', parentId: null },
    { categoryId: 'CAT-002', name: 'Edibles', parentId: null },
    { categoryId: 'CAT-003', name: 'Flower', parentId: null },
    { categoryId: 'CAT-004', name: 'Vapes', parentId: null },
    { categoryId: 'CAT-005', name: 'Tinctures', parentId: null }
  ];
}

function listSalesWithLineItems({ status = 'CLOSED', limit = 200, outletId = null } = {}) {
  // Generate mock sales with line items for snapshot testing
  const now = new Date();
  const mockSalesData = [];

  for (let i = 0; i < 10; i++) {
    const saleDate = new Date(now.getTime() - i * 3600000); // Each sale 1 hour apart
    const outlet = outletId ? mockOutlets.find(o => o.outletId === outletId) : mockOutlets[i % 2];

    mockSalesData.push({
      saleId: `SALE-${1000 + i}`,
      total: 50 + Math.random() * 100,
      totalTax: 5 + Math.random() * 10,
      outletId: outlet?.outletId || 'OUTLET-001',
      registerId: 'REG-001',
      userId: mockUsers[i % 2].userId,
      customerId: i % 3 === 0 ? mockCustomers[i % 3]?.customerId : null,
      status: 'CLOSED',
      saleDate: saleDate.toISOString(),
      lineItems: [
        {
          productId: mockProducts[i % mockProducts.length].productId,
          productName: mockProducts[i % mockProducts.length].name,
          sku: mockProducts[i % mockProducts.length].sku,
          quantity: 1 + Math.floor(Math.random() * 3),
          unitPrice: mockProducts[i % mockProducts.length].price,
          lineTotal: mockProducts[i % mockProducts.length].price * (1 + Math.floor(Math.random() * 3))
        }
      ]
    });
  }

  return mockSalesData.slice(0, limit);
}

function searchSalesWithLineItems({ outletId = null } = {}) {
  return listSalesWithLineItems({ status: 'CLOSED', limit: 200, outletId });
}

function searchSalesRaw({ outletId = null, limit = 10 } = {}) {
  const sales = listSalesWithLineItems({ status: 'CLOSED', limit: 200, outletId });
  return sales.slice(0, limit).map((s) => ({
    id: s.saleId,
    outlet_id: s.outletId,
    status: s.status,
    total_price: s.total,
    line_items: (s.lineItems || []).map((li) => ({
      product_id: li.productId,
      quantity: li.quantity,
      total: li.lineTotal
    }))
  }));
}

function getUserById(userId) {
  return mockUsers.find(u => u.userId === userId) || null;
}

function getOutletById(outletId) {
  return mockOutlets.find(o => o.outletId === outletId) || null;
}

module.exports = {
  getSaleById,
  recordVerification,
  completeSale,
  listSales,
  listSalesWithLineItems,
  searchSalesWithLineItems,
  searchSalesRaw,
  listVerifications,
  getComplianceReport,
  getAuthState,
  listOutlets,
  listProducts,
  getProductById,
  listInventory,
  listCustomers,
  listCustomersRaw,
  getCustomerById,
  updateCustomerById,
  listUsers,
  listCategories,
  getUserById,
  getOutletById
};
