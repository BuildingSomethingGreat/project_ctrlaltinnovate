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

export async function createPaymentLink(paymentLinkData) {
  const { productId, sellerId, email, expiresAt } = paymentLinkData;

  // Validate required fields
  if (!productId) {
    throw new Error('productId is required to create a payment link');
  }

  // if (!sellerId && email) {
    try {
      const { seller } = await createSeller(email);
      paymentLinkData.sellerId = seller.sellerId; // Update sellerId in paymentLinkData
    } catch (err) {
      console.error('Failed to create seller:', err);
      throw new Error('Failed to create seller account');
    }
  // }

  if (!paymentLinkData.sellerId) {
    throw new Error('sellerId is required to create a payment link');
  }

  // Call the API to create the payment link
  const response = await callApi('/api/links', {
    method: 'POST',
    body: JSON.stringify({
      productId: paymentLinkData.productId,
      sellerId: paymentLinkData.sellerId,
      expiresAt: paymentLinkData.expiresAt || null // Include expiration date if provided
    })
  });

  return response; // This should include linkId, pageUrl, and onboardingUrl
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