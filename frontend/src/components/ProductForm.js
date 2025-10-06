import React, { useState } from 'react';
import { createProduct, createPaymentLink } from '../utils/api';
import { styles } from '../styles/shared';

function ProductForm() {
  const [loading, setLoading] = useState(false);
  const [paymentLink, setPaymentLink] = useState(null);
  const [error, setError] = useState(null);
  const [imageFile, setImageFile] = useState(null); // State to store the uploaded file
  const [imageUrl, setImageUrl] = useState(''); // State to store the provided image URL

  const handleImageUpload = async (file) => {
    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': file.type // Set the content type to the file's MIME type
        },
        body: file // Send the raw file as the request body
      });

      if (!response.ok) {
        throw new Error('Failed to upload image');
      }

      const data = await response.json();
      return data.imageUrl; // The public URL of the uploaded image
    } catch (err) {
      console.error('Image upload error:', err);
      throw err;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      let finalImageUrl = imageUrl; // Default to the provided URL

      // If a file is uploaded, upload it and use the resulting URL
      if (imageFile) {
        finalImageUrl = await handleImageUpload(imageFile);
      }

      // Create product
      const productData = {
        sellerId: 'test-seller',
        title: e.target.title.value,
        description: e.target.description.value,
        price_cents: Math.round(parseFloat(e.target.price.value) * 100),
        currency: 'usd',
        image_url: finalImageUrl // Use the final image URL
      };

      const { product } = await createProduct(productData);

      // Create payment link with seller email
      const { pageUrl } = await createPaymentLink(
        product.productId,
        null,
        e.target.sellerEmail.value
      );

      setPaymentLink(pageUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.card}>
      <h1 style={styles.title}>Create Payment Link</h1>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 15 }}>
          <label style={styles.label}>
            Title
            <input type="text" name="title" required style={styles.input} />
          </label>
        </div>

        <div style={{ marginBottom: 15 }}>
          <label style={styles.label}>
            Description
            <textarea name="description" rows={3} style={styles.input} />
          </label>
        </div>

        <div style={{ marginBottom: 15 }}>
          <label style={styles.label}>
            Price (USD)
            <input
              type="number"
              name="price"
              min="0.50"
              step="0.01"
              required
              style={styles.input}
            />
          </label>
        </div>

        <div style={{ marginBottom: 15 }}>
          <label style={styles.label}>
            Product Image
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setImageFile(e.target.files[0])}
              style={styles.input}
            />
          </label>
        </div>

        <div style={{ marginBottom: 15 }}>
          <label style={styles.label}>
            Product Image URL (Optional)
            <input
              type="url"
              name="imageUrl"
              placeholder="https://example.com/image.jpg"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              style={styles.input}
            />
          </label>
        </div>

        <div style={{ marginBottom: 15 }}>
          <label style={styles.label}>
            Seller Email
            <input
              type="email"
              name="sellerEmail"
              required
              style={styles.input}
              placeholder="seller@example.com"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={loading}
          style={{
            ...styles.button,
            opacity: loading ? 0.7 : 1
          }}
        >
          {loading ? 'Creating...' : 'Create Payment Link'}
        </button>
      </form>

      {error && <div style={styles.error}>Error: {error}</div>}
      {paymentLink && (
        <div style={styles.small}>
          <p>Payment Link Created:</p>
          <a
            href={paymentLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#2563eb' }}
          >
            {paymentLink}
          </a>
        </div>
      )}
    </div>
  );
}

export default ProductForm;