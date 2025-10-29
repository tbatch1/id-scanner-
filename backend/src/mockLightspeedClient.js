const { v4: uuidv4 } = require('uuid');

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
        }
      ],
      customer: {
        firstName: 'Alex',
        lastName: 'Rivera',
        dob: '1998-05-12'
      },
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

function getSaleById(saleId) {
  const sale = saleStore.get(saleId);
  if (!sale) {
    return null;
  }

  const verification = sale.lastVerificationId
    ? verificationStore.get(sale.lastVerificationId) || null
    : null;

  return {
    ...sale,
    verification
  };
}

function recordVerification({ saleId, clerkId, verificationData }) {
  const sale = saleStore.get(saleId);
  if (!sale) {
    throw new Error('SALE_NOT_FOUND');
  }

  const verificationId = uuidv4();
  const timestamp = new Date().toISOString();

  const record = {
    verificationId,
    saleId,
    clerkId,
    status: verificationData.approved ? 'approved' : 'rejected',
    reason: verificationData.approved ? null : verificationData.reason || 'Underage or invalid ID',
    payload: {
      firstName: verificationData.firstName || null,
      lastName: verificationData.lastName || null,
      dob: verificationData.dob || null,
      rawAge: verificationData.age || null
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };

  verificationStore.set(verificationId, record);

  sale.lastVerificationId = verificationId;
  sale.status = verificationData.approved ? 'verified' : 'awaiting_verification';
  sale.updatedAt = timestamp;

  saleStore.set(saleId, sale);

  return record;
}

function completeSale({ saleId, verificationId }) {
  const sale = saleStore.get(saleId);
  if (!sale) {
    throw new Error('SALE_NOT_FOUND');
  }

  if (!verificationId || !verificationStore.has(verificationId)) {
    throw new Error('VERIFICATION_NOT_FOUND');
  }

  const verification = verificationStore.get(verificationId);
  if (verification.status !== 'approved') {
    throw new Error('VERIFICATION_NOT_APPROVED');
  }

  const completionId = uuidv4();
  const timestamp = new Date().toISOString();

  sale.status = 'completed';
  sale.updatedAt = timestamp;
  sale.completion = {
    completionId,
    verificationId,
    completedAt: timestamp
  };

  saleStore.set(saleId, sale);

  return {
    saleId,
    completionId,
    verificationId,
    status: sale.status,
    completedAt: timestamp
  };
}

function listSales() {
  return Array.from(saleStore.values()).map((sale) => ({
    ...sale,
    verification: sale.lastVerificationId ? verificationStore.get(sale.lastVerificationId) || null : null
  }));
}

module.exports = {
  getSaleById,
  recordVerification,
  completeSale,
  listSales
};
