// Mock Lightspeed Client - Used when API credentials are not configured

const config = require('./config');

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
  storedSale.updatedAt = timestamp;

  saleStore.set(saleId, storedSale);

  return record;
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

function listSales() {
  return Array.from(saleStore.values()).map((sale) => getSaleById(sale.saleID));
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

module.exports = {
  getSaleById,
  recordVerification,
  completeSale,
  listSales,
  listVerifications,
  getComplianceReport,
  getAuthState
};
