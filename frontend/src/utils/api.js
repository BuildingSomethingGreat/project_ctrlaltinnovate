const API_BASE = 'http://localhost:4242';
const API_KEY = 'AIzaSyBB-ExXfQEIjrB8pMORGMiBdDcRWK3NdXY'; // Same as in backend .env

async function callApi(endpoint, options = {}) {
    console.log(`Calling API: ${endpoint} with options:`, options); // Debug log
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    ...options.headers
  };

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
  return callApi('/api/products', {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function createPaymentLink(productId, sellerId, email) {
  // Create seller first if sellerId not provided
  if (!sellerId && email) {
    try {
      const { seller } = await createSeller(email);
      sellerId = seller.sellerId;
    } catch (err) {
      console.error('Failed to create seller:', err);
      throw new Error('Failed to create seller account');
    }
  }

  return callApi('/api/links', {
    method: 'POST',
    body: JSON.stringify({ productId, sellerId })
  });
}

export async function createSeller(email) {
  return callApi('/api/seed/seller', {
    method: 'POST',
    body: JSON.stringify({ email })
  });
}