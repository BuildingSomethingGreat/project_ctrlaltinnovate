// const API_BASE = process.env.REACT_APP_FRONTEND_BASE_URL || 'http://localhost:4242';
// const API_BASE = 'http://localhost:4242'; // Use this for local development
const API_BASE = 'https://ctrlaltinnovate-64f4a6aee6b6.herokuapp.com';


const API_KEY = process.env.REACT_APP_FIREBASE_API_KEY;

async function callApi(endpoint, options = {}) {
  console.log('Hey');
  console.log(`Calling API: ${endpoint} with options:`, options); // Debug log
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    ...options.headers
  };

  console.log('API_BASE', API_BASE);

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'API request failed');
  }

  return response.json();
}

export async function createProduct(data) {
  const product = await callApi('/api/products', {
    method: 'POST',
    body: JSON.stringify(data)
  });

  console.log('Created product:', product); // Debug log
  return product;
}

export async function createPaymentLink(dataOrProductId, sellerId, email) {
  // Support both old signature and new object payload
  const payload = typeof dataOrProductId === 'object'
    ? dataOrProductId
    : { productId: dataOrProductId, sellerId, email };

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