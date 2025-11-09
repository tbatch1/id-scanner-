export const state = {
  saleId: null,
  clerkId: null,
  paymentType: 'cash',
  apiBase: '',
  apiKey: null,
  latestVerification: null,
  scannerInitialized: false,
  locationId: null,
  outlet: null,
  registerId: null,
  customerPhone: null,
  autoClose: false
};

export function setSaleContext({
  saleId,
  clerkId,
  paymentType,
  apiBase,
  apiKey,
  locationId,
  customerPhone,
  autoClose
}) {
  state.saleId = saleId;
  state.clerkId = clerkId;
  state.paymentType = paymentType || 'cash';
  state.apiBase = apiBase;
  state.apiKey = apiKey || null;
  if (locationId) {
    state.locationId = locationId;
  }
  if (typeof customerPhone !== 'undefined') {
    state.customerPhone = customerPhone || null;
  }
  if (typeof autoClose !== 'undefined') {
    state.autoClose = Boolean(autoClose);
  }
}

export function setLatestVerification(verification) {
  state.latestVerification = verification;
}

export function clearLatestVerification() {
  state.latestVerification = null;
}

export function markScannerInitialized() {
  state.scannerInitialized = true;
}

export function setSaleLocation({ locationId, outlet, registerId } = {}) {
  if (typeof locationId !== 'undefined') {
    state.locationId = locationId || null;
  }
  if (typeof outlet !== 'undefined') {
    state.outlet = outlet || null;
  }
  if (typeof registerId !== 'undefined') {
    state.registerId = registerId || null;
  }
}
