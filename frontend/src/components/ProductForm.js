import React, { useState } from 'react';
import { createProduct, createPaymentLink, createSeller, uploadDigital } from '../utils/api'; // add uploadDigital

function ProductForm() {
  const [formData, setFormData] = useState({
    productName: '',
    description: '',
    price: '',
    currency: 'USD',
    isSubscription: false,
    expirationDate: '', // e.g. 2025-12-31T23:59
    advancedSettings: false,
    customField: '',
    sellerEmail: '', // New field for seller's email
    imageFile: null, // For uploaded image
    imageUrl: '', // For image URL
    digitalFile: null, // NEW: digital download file
    digitalFileUrl: '', // NEW: public URL for digital download (optional)
    auctionEnabled: false,
    auctionEndsAt: '', // e.g. 2025-01-31T23:59
    auctionStartingPrice: '',
    auctionMinIncrement: '',
    checkoutSchema: {
      backgroundColor: '#f7fafc',
      buttonColor: '#2563eb',
      textColor: '#0f172a'
    }
  });

  const [previewLink, setPreviewLink] = useState('');
  const [onboardingLink, setOnboardingLink] = useState(''); // New state for onboarding link
  const [validationErrors, setValidationErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  const handleColorChange = (field, value) => {
    setFormData({
      ...formData,
      checkoutSchema: { ...formData.checkoutSchema, [field]: value }
    });
  };

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
      const priceRequired = !formData.auctionEnabled;
      if (!formData.productName || !formData.sellerEmail || (priceRequired && !formData.price)) {
        setValidationErrors({
          productName: !formData.productName ? 'Product name is required' : '',
          price: (priceRequired && !formData.price) ? 'Price is required unless auction is enabled' : '',
          sellerEmail: !formData.sellerEmail ? 'Seller email is required' : ''
        });
        setLoading(false);
        return;
      }

      // Optional: simple future-date check for non-auction expiration
      if (!formData.auctionEnabled && formData.expirationDate) {
        const exp = new Date(formData.expirationDate);
        if (isNaN(exp.getTime()) || exp <= new Date()) {
          setValidationErrors((v) => ({ ...v, expirationDate: 'Expiration must be a future date/time' }));
          setLoading(false);
          return;
        }
      }

      let finalImageUrl = formData.imageUrl;

      // If an image file is uploaded, upload it to the server
      if (formData.imageFile) {
        finalImageUrl = await handleImageUpload(formData.imageFile);
      }

      // Create seller
      const sellerData = formData.sellerEmail;
      const { seller } = await createSeller(sellerData); // Use createSeller from api.js
      console.log('Seller created:', seller); // Debug log

      // Create product
      const productData = {
        sellerId: seller.sellerId, // Use the created sellerId
        title: formData.productName,
        description: formData.description,
        currency: (formData.currency || 'USD').toLowerCase(),
        image_url: finalImageUrl,
        checkoutSchema: formData.checkoutSchema,
        // include price only when provided (auction may omit)
        ...(formData.price ? { price_cents: Math.round(parseFloat(formData.price) * 100) } : {}),
        // optional digital URL passthrough
        ...(formData.digitalFileUrl ? { digitalFileUrl: formData.digitalFileUrl } : {})
      };

      const { product } = await createProduct(productData); // Use createProduct from api.js
      console.log('Product created:', product); // Debug log

      // Upload digital file (optional) AFTER product exists so we can scope to productId
      if (formData.digitalFile) {
        await uploadDigital(product.productId, formData.digitalFile);
      }

      // Create payment link
      const paymentLinkData = {
        productId: product.productId,
        sellerId: product.sellerId,
        email: formData.sellerEmail,
        // Only send expiresAt for non-auction links
        expiresAt: !formData.auctionEnabled && formData.expirationDate
          ? new Date(formData.expirationDate).toISOString()
          : null,
        digitalFileUrl: formData.digitalFileUrl || null, // NEW
        auction: formData.auctionEnabled ? {
          enabled: true,
          endsAt: formData.auctionEndsAt,
          startingPrice_cents: formData.auctionStartingPrice ? Math.round(parseFloat(formData.auctionStartingPrice) * 100) : undefined,
          minIncrement_cents: formData.auctionMinIncrement ? Math.round(parseFloat(formData.auctionMinIncrement) * 100) : undefined
        } : undefined
      };

      console.log('Creating payment link with data:', paymentLinkData); // Debug log
      const { pageUrl, onboardingUrl } = await createPaymentLink(paymentLinkData); // Use createPaymentLink from api.js

      // Update preview link and onboarding link
      setPreviewLink(pageUrl);
      setOnboardingLink(onboardingUrl || ''); // Set onboarding link if available
    } catch (err) {
      console.error('Error creating payment link:', err);
      setError(err.message || 'Failed to create payment link');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.grid}>
        {/* Form Section */}
        <div style={styles.formCard}>
          <h1 style={styles.heading}>Create Payment Link</h1>
          <form onSubmit={handleSubmit}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Product Name</label>
              <input
                type="text"
                name="productName"
                value={formData.productName}
                onChange={handleInputChange}
                style={styles.input}
                placeholder="Enter product name"
              />
              {validationErrors.productName && (
                <span style={styles.error}>{validationErrors.productName}</span>
              )}
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Description</label>
              <textarea
                name="description"
                value={formData.description}
                onChange={handleInputChange}
                style={styles.textarea}
                placeholder="Enter product description"
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Price</label>
              <div style={styles.inlineGroup}>
                <input
                  type="number"
                  name="price"
                  value={formData.price}
                  onChange={handleInputChange}
                  style={styles.input}
                  placeholder="0.00"
                />
                <select
                  name="currency"
                  value={formData.currency}
                  onChange={handleInputChange}
                  style={styles.select}
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                </select>
              </div>
              {validationErrors.price && (
                <span style={styles.error}>{validationErrors.price}</span>
              )}
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Seller Email</label>
              <input
                type="email"
                name="sellerEmail"
                value={formData.sellerEmail}
                onChange={handleInputChange}
                style={styles.input}
                placeholder="Enter seller email"
              />
              {validationErrors.sellerEmail && (
                <span style={styles.error}>{validationErrors.sellerEmail}</span>
              )}
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Product Image</label>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setFormData({ ...formData, imageFile: e.target.files[0] })}
                style={styles.input}
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Digital File (Optional)</label>
              <input
                type="file"
                accept="*/*"
                onChange={(e) => setFormData({ ...formData, digitalFile: e.target.files[0] })}
                style={styles.input}
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Product Image URL (Optional)</label>
              <input
                type="url"
                name="imageUrl"
                value={formData.imageUrl}
                onChange={handleInputChange}
                style={styles.input}
                placeholder="https://example.com/image.jpg"
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Digital Download URL (optional)</label>
              <input
                type="url"
                name="digitalFileUrl"
                placeholder="https://example.com/your-file.zip"
                value={formData.digitalFileUrl}
                onChange={(e) => setFormData({ ...formData, digitalFileUrl: e.target.value })}
                style={styles.input}
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Background Color</label>
              <input
                type="color"
                value={formData.checkoutSchema.backgroundColor}
                onChange={(e) => handleColorChange('backgroundColor', e.target.value)}
                style={styles.input}
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Button Color</label>
              <input
                type="color"
                value={formData.checkoutSchema.buttonColor}
                onChange={(e) => handleColorChange('buttonColor', e.target.value)}
                style={styles.input}
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Text Color</label>
              <input
                type="color"
                value={formData.checkoutSchema.textColor}
                onChange={(e) => handleColorChange('textColor', e.target.value)}
                style={styles.input}
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>
                <input
                  type="checkbox"
                  checked={formData.auctionEnabled}
                  onChange={(e) => setFormData({ ...formData, auctionEnabled: e.target.checked })}
                />
                {' '}Enable Auction/Bidding
              </label>
            </div>
            {formData.auctionEnabled && (
              <>
                <div style={styles.formGroup}>
                  <label style={styles.label}>Auction Ends At</label>
                  <input
                    type="datetime-local"
                    value={formData.auctionEndsAt}
                    onChange={(e) => setFormData({ ...formData, auctionEndsAt: e.target.value })}
                    style={styles.input}
                  />
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label}>Starting Price (USD)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.auctionStartingPrice}
                    onChange={(e) => setFormData({ ...formData, auctionStartingPrice: e.target.value })}
                    style={styles.input}
                  />
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label}>Min Increment (USD)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.auctionMinIncrement}
                    onChange={(e) => setFormData({ ...formData, auctionMinIncrement: e.target.value })}
                    style={styles.input}
                  />
                </div>
              </>
            )}

            {/* NEW: Non-auction expiration field */}
            {!formData.auctionEnabled && (
              <div style={{ marginBottom: 15 }}>
                <label style={styles.label}>
                  Offer Expires At (optional)
                  <input
                    type="datetime-local"
                    name="expirationDate"
                    value={formData.expirationDate}
                    onChange={(e) => setFormData({ ...formData, expirationDate: e.target.value })}
                    style={styles.input}
                  />
                </label>
                {validationErrors?.expirationDate && (
                  <div style={{ color: 'red', fontSize: 12 }}>{validationErrors.expirationDate}</div>
                )}
                <div className="small" style={{ color: '#475569' }}>
                  If set, buyers will see the expiry and cannot checkout after it passes.
                </div>
              </div>
            )}

            <button type="submit" style={styles.submitButton} disabled={loading}>
              {loading ? 'Creating...' : 'Generate Link'}
            </button>
          </form>
          {error && <div style={styles.error}>Error: {error}</div>}
        </div>

        {/* Preview Section */}
        <div style={styles.previewCard}>
          <h2 style={styles.previewHeading}>Preview</h2>
          <div
            style={{
              ...styles.previewContainer,
              backgroundColor: formData.checkoutSchema.backgroundColor,
              color: formData.checkoutSchema.textColor
            }}
          >
            <div style={styles.previewLink}>
              {previewLink ? (
                <a href={previewLink} target="_blank" rel="noopener noreferrer">
                  Payment Link
                </a>
              ) : (
                'Preview will appear here'
              )}
            </div>
            {onboardingLink && (
              <div style={styles.previewLink}>
                <a href={onboardingLink} target="_blank" rel="noopener noreferrer">
                  Onboarding Link
                </a>
              </div>
            )}
            <button
              style={{
                ...styles.previewButton,
                backgroundColor: formData.checkoutSchema.buttonColor
              }}
            >
              Buy Now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    padding: '32px',
    backgroundColor: '#f9f9f9',
    fontFamily: 'Inter, sans-serif'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '8fr 4fr',
    gap: '24px',
    maxWidth: '1200px',
    margin: '0 auto'
  },
  formCard: {
    background: '#fff',
    borderRadius: '12px',
    padding: '24px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)'
  },
  previewCard: {
    background: '#fff',
    borderRadius: '12px',
    padding: '24px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
    position: 'sticky',
    top: '32px'
  },
  previewContainer: {
    padding: '16px',
    borderRadius: '8px',
    textAlign: 'center'
  },
  previewButton: {
    padding: '12px',
    borderRadius: '8px',
    color: '#fff',
    border: 'none',
    fontWeight: '600',
    cursor: 'pointer',
    marginTop: '16px'
  },
  previewHeading: {
    fontSize: '20px',
    fontWeight: '600',
    marginBottom: '16px'
  },
  previewLink: {
    fontSize: '16px',
    marginBottom: '16px'
  },
  formGroup: {
    marginBottom: '16px'
  },
  label: {
    display: 'block',
    fontSize: '14px',
    color: '#6b7280',
    marginBottom: '8px'
  },
  input: {
    width: '100%',
    padding: '12px',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    fontSize: '14px'
  },
  textarea: {
    width: '100%',
    padding: '12px',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    fontSize: '14px',
    resize: 'none'
  },
  inlineGroup: {
    display: 'flex',
    gap: '8px'
  },
  select: {
    padding: '12px',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    fontSize: '14px'
  },
  error: {
    color: '#e53e3e',
    fontSize: '14px',
    marginTop: '8px'
  },
  submitButton: {
    width: '100%',
    padding: '12px',
    borderRadius: '8px',
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    fontSize: '16px',
    fontWeight: '600',
    cursor: 'pointer',
    marginTop: '16px'
  }
};

export default ProductForm;