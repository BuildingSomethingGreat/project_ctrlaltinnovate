// const API_BASE = process.env.REACT_APP_FRONTEND_BASE_URL || 'http://localhost:4242';
// const API_BASE = 'http://localhost:4242'; // Use this for local development
const API_BASE = 'https://ctrlaltinnovate-64f4a6aee6b6.herokuapp.com';


const API_KEY = process.env.REACT_APP_FIREBASE_API_KEY;

async function callApi(path, init = {}) {
  const base = process.env.REACT_APP_BACKEND_BASE_URL || '';
  const headers = {
    'Content-Type': 'application/json',
    ...(init.headers || {})
  };
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(json.error || json.message || `HTTP ${res.status}`);
  }
  return json;
}

export async function createProduct(data) {
  return callApi('/api/products', {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function createPaymentLink(payload) {
  // payload should include { productId, sellerId?, email? }
  return callApi('/api/links', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function createSeller(email) {
  return callApi('/api/seed/seller', {
    method: 'POST',
    body: JSON.stringify({ email })
  });
}

export async function uploadDigital(productId, file) {
  if (!productId || !file) throw new Error('productId and file are required');

  const res = await callApi(`/api/products/${productId}/digital`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name)
    },
    body: file
  });

  return res; // { digitalDownload }
}

export async function resolveSeller(email) {
  const res = await fetch(`/api/sellers/resolve?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error('Failed to resolve seller');
  return res.json(); // { seller: { sellerId, emailVerified, ... } | null }
}

export async function requestMagicLink(email) {
  return callApi('/api/sellers/request-magic-link', {
    method: 'POST',
    body: JSON.stringify({ email })
  });
}

export async function getSellerSummary(sellerId) {
  return callApi(`/api/sellers/${encodeURIComponent(sellerId)}/summary`, { method: 'GET' });
}

export async function getSellerLedger(sellerId, limit = 25) {
  return callApi(`/api/sellers/${encodeURIComponent(sellerId)}/ledger?limit=${limit}`, { method: 'GET' });
}

export async function requestPayout(sellerId) {
  return callApi('/api/payouts/request', {
    method: 'POST',
    body: JSON.stringify({ sellerId })
  });
}