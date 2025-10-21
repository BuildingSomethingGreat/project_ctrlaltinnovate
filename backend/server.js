// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { nanoid } = require('nanoid');
const mustache = require('mustache');
const fs = require('fs');
const path = require('path');

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY)
const admin = require('firebase-admin');
const { formatPrice } = require('./utils/mustacheHelpers');

const { verifyFirebaseToken } = require('./middleware/firebaseAuth');
const privateKey = JSON.parse(process.env.FIREBASE_PRIVATE_KEY).private_key.replace(/\\n/g, '\n');

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const { generateEmailTemplate } = require('./utils/emailTemplate');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    }),
  });
}
const db = admin.firestore();

const { Storage } = require('@google-cloud/storage');

// Initialize Firebase Storage
const storage = new Storage({
  projectId: process.env.FIREBASE_PROJECT_ID,
  credentials: {
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: privateKey
  }
});

const bucket = storage.bucket(`${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`);

function sanitizeFilename(name = '') {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 140);
}

function guessContentTypeFromExt(name = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    txt: 'text/plain',
    md: 'text/markdown'
  };
  return map[ext] || 'application/octet-stream';
}

function buildDigitalDownloadFromUrl(url) {
  try {
    const u = new URL(url);
    const fileName = sanitizeFilename(decodeURIComponent(u.pathname.split('/').pop() || 'download'));
    return {
      fileName,
      contentType: guessContentTypeFromExt(fileName),
      storagePath: null,        // not stored in GCS
      fileSize: null,           // unknown
      updatedAt: new Date().toISOString(),
      contentUrl: url           // public URL source
    };
  } catch {
    return null;
  }
}

const app = express();

// Serve static files from the React frontend app
app.use(express.static(path.join(__dirname, '../frontend/build')));

/**
 * Auto-fulfill digital orders:
 * - Attaches digital file (from product or link snapshot) and emails buyer with product image.
 * - After buyer email is sent successfully, emails seller that the order was auto-fulfilled.
 * Returns true if fulfillment email sent to buyer; otherwise false.
 */
async function autoFulfillDigitalOrder(session) {
  try {
    const linkId = session.metadata?.linkId;
    const productId = session.metadata?.productId;
    const sellerId = session.metadata?.sellerId;
    if (!productId || !sellerId) return false;

    const [productSnap, sellerSnap, linkSnap] = await Promise.all([
      db.collection('products').doc(productId).get(),
      db.collection('sellers').doc(sellerId).get(),
      linkId ? db.collection('links').doc(linkId).get() : Promise.resolve({ exists: false })
    ]);
    if (!productSnap.exists || !sellerSnap.exists) return false;

    const product = productSnap.data();
    const seller = sellerSnap.data();
    const link = linkSnap.exists ? linkSnap.data() : null;

    const digital = product.digitalDownload || link?.digitalDownload || null;
    if (!digital) return false;

    const buyerEmail = session.customer_details?.email || session.customer_email || null;
    if (!buyerEmail) return false;

    // Prepare attachment from storagePath or contentUrl
    let attachment = null;

    if (digital.storagePath) {
      const fileRef = bucket.file(digital.storagePath);
      const [buffer] = await fileRef.download();
      attachment = {
        filename: digital.fileName || 'download',
        content: buffer,
        contentType: digital.contentType || 'application/octet-stream'
      };
    } else if (digital.contentUrl) {
      // Node 18+ has global fetch; fallback to dynamic import if needed
      const resp = await (global.fetch
        ? fetch(digital.contentUrl)
        : (await import('node-fetch')).default(digital.contentUrl));
      if (resp.ok) {
        const ab = await resp.arrayBuffer();
        const buffer = Buffer.from(ab);
        attachment = {
          filename: digital.fileName || 'download',
          content: buffer,
          contentType: digital.contentType || resp.headers.get('content-type') || 'application/octet-stream'
        };
      }
    }

    const buyerHtml = generateEmailTemplate({
      appName: 'CtrlAltInnovate',
      title: 'Your download is ready',
      message: `Thanks for your purchase of <strong>${product.title}</strong>. Your file is attached.`,
      details: `
        ${product.image_url ? `<img src="${product.image_url}" alt="${product.title}" style="max-width:100%; border-radius:8px; margin-bottom:12px;" />` : ''}
        <div>Order total: ${formatPrice(session.amount_total, product.currency || 'usd')}</div>
        ${(!attachment && digital.contentUrl) ? `<div style="margin-top:8px;">If the attachment is missing, you can also download your file here: <a href="${digital.contentUrl}">${digital.contentUrl}</a></div>` : ''}
      `
    });

    // Send buyer email (with attachment when available)
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'no-reply@ctrlaltinnovate.com',
      to: buyerEmail,
      subject: `Your ${product.title} download`,
      html: buyerHtml,
      ...(attachment ? { attachments: [attachment] } : {})
    });

    // Notify seller
    const sellerHtml = generateEmailTemplate({
      appName: 'CtrlAltInnovate',
      title: 'Your order was automatically fulfilled',
      message: `An order for <strong>${product.title}</strong> was automatically fulfilled via digital delivery.`,
      details: `
        <div>Buyer: ${buyerEmail}</div>
        <div>Amount: ${formatPrice(session.amount_total, product.currency || 'usd')}</div>
        ${product.image_url ? `<div style="margin-top:12px;"><img src="${product.image_url}" alt="${product.title}" style="max-width:100%; border-radius:8px;" /></div>` : ''}
      `
    });

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'no-reply@ctrlaltinnovate.com',
      to: seller.email,
      subject: 'Your order was automatically fulfilled',
      html: sellerHtml
    });

    return true;
  } catch (err) {
    console.error('autoFulfillDigitalOrder failure:', err);
    return false;
  }
}

/**
 * Webhook endpoint
 * POST /webhook
 */
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature verification failed', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // Extract metadata from the session
        const { sellerId, productId } = session.metadata;

        // Reference the seller in the database
        const sellerSnap = await db.collection('sellers').doc(sellerId).get();
        if (!sellerSnap.exists) {
          console.error(`Seller not found: ${sellerId}`);
          return res.status(404).send({ error: 'Seller not found' });
        }
        const seller = sellerSnap.data();

        // Reference the product in the database
        const productSnap = await db.collection('products').doc(productId).get();
        if (!productSnap.exists) {
          console.error(`Product not found: ${productId}`);
          return res.status(404).send({ error: 'Product not found' });
        }
        const product = productSnap.data();

        // Send email to seller
        const emailHtml = generateEmailTemplate({
          appName: 'CtrlAltInnovate',
          title: 'New Order Received!',
          message: `A customer has purchased your product: ${product.title}.`,
          details: `Order Amount: $${(session.amount_total / 100).toFixed(2)}`
        });

        await resend.emails.send({
          from: 'ctrlaltinnovate@notifications.edwardstechnology.app',
          to: seller.email,
          subject: 'New Order Received!',
          html: emailHtml
        });

        // Initiate a payout to the seller
        try {
          const payout = await stripe.transfers.create({
            amount: session.amount_total, // Total amount in cents
            currency: session.currency,
            destination: seller.stripeAccountId, // Seller's Stripe account ID
            metadata: {
              productId,
              sellerId,
              orderId: session.payment_intent || session.id
            }
          });
          console.log('Payout initiated:', payout);
        } catch (err) {
          console.error('Failed to create payout:', err);
        }

        // Update the product document to set isSold to true
        const productRef = db.collection('products').doc(productId);
        await productRef.update({ isSold: true });

        // Save the order details in the database
        const orderRef = db.collection('orders').doc(session.payment_intent || session.id);
        const orderDoc = {
          orderId: session.payment_intent || session.id,
          checkoutSessionId: session.id,
          linkId: session.metadata?.linkId,
          productId,
          sellerId,
          amount_total: session.amount_total,
          currency: session.currency,
          buyer_email: session.customer_details?.email || null,
          shipping: session.shipping || null,
          status: 'completed',
          createdAt: new Date().toISOString()
        };
        await orderRef.set(orderDoc);

        // ADD: auto-fulfill digital orders (buyer + seller notifications)
        try {
          const fulfilled = await autoFulfillDigitalOrder(session);
          if (!fulfilled) {
            console.log('No digital download to fulfill or buyer email missing.');
          }
        } catch (e) {
          console.error('Auto-fulfillment error:', e);
        }

        console.log('Order saved and product updated.');
        break;
      }

      default:
        console.log(`Unhandled event type ${event.type}`);
        break;
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
});

app.use(cors());
app.use(bodyParser.json());

// Helpers
function renderPaymentPage(product, link) {
  const template = fs.readFileSync(path.join(__dirname, 'templates', 'payment_page.mustache'), 'utf8');
  // ensure price_display present
  product.price_display = formatPrice(product.price_cents, product.currency);
  const html = mustache.render(template, { product, link });
  return html;
}

// Serve the uploaded files statically
app.use('/uploads', express.static('uploads'));

/**
 * Image upload endpoint
 * POST /api/upload
 */
app.post('/api/upload', bodyParser.raw({ type: 'image/*', limit: '10mb' }), async (req, res) => {
  try {
    const fileBuffer = req.body; // The raw file buffer
    const contentType = req.headers['content-type']; // Get the content type from the headers
    const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}`; // Generate a unique file name

    if (!fileBuffer || !contentType) {
      return res.status(400).send({ error: 'No file uploaded or invalid content type' });
    }

    // Create a reference to the file in Firebase Storage
    const blob = bucket.file(`uploads/${fileName}`);
    const blobStream = blob.createWriteStream({
      metadata: {
        contentType: contentType
      }
    });

    blobStream.on('error', (err) => {
      console.error('Blob stream error:', err);
      res.status(500).send({ error: 'Failed to upload image' });
    });

    blobStream.on('finish', async () => {
      // Make the file publicly accessible
      await blob.makePublic();

      // Construct the public URL
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
      res.json({ imageUrl: publicUrl });
    });

    // Write the file buffer to Firebase Storage
    blobStream.end(fileBuffer);
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).send({ error: 'Failed to upload image' });
  }
});

// --- Routes ---

/**
 * Create Stripe Express connected account and onboarding link
 * POST /api/sellers/onboard
 * body: { sellerId (optional), email, business_type, country, business_profile }
 */
app.post('/api/sellers/onboard', verifyFirebaseToken, async (req, res) => {
  try {
    const { sellerId, email, business_type, country, business_profile } = req.body;
    const account = await stripe.accounts.create({
      type: 'express',
      country: country || 'US',
      email,
      business_type: business_type || 'individual',
      business_profile: business_profile || undefined
    });

    const newSellerId = sellerId || nanoid(10);
    const sellerDoc = {
      sellerId: newSellerId,
      email,
      stripeAccountId: account.id,
      stripeAccountStatus: account?.capabilities || {},
      createdAt: new Date().toISOString()
    };
    await db.collection('sellers').doc(newSellerId).set(sellerDoc);

    const origin = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${origin}/onboard/refresh?sellerId=${newSellerId}`,
      return_url: `${origin}/onboard/success?sellerId=${newSellerId}`,
      type: 'account_onboarding'
    });

    // Send welcome email
    const emailHtml = generateEmailTemplate({
      appName: 'CtrlAltInnovate',
      title: 'Welcome to CtrlAltInnovate!',
      message: 'Thank you for signing up as a seller. Please complete your onboarding to start receiving payments.',
      details: `<a href="${accountLink.url}" style="color: #2563eb; text-decoration: none;">Complete Onboarding</a>`
    });

    await resend.emails.send({
      from: 'ctrlaltinnovate@notifications.edwardstechnology.app',
      to: email,
      subject: 'Welcome to CtrlAltInnovate!',
      html: emailHtml
    });

    res.json({ sellerId: newSellerId, stripeAccountId: account.id, accountLink: accountLink.url });
  } catch (err) {
    console.error('onboard err', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create product
 * POST /api/products
 * body: { sellerId, title, description, price_cents, currency, image_url, inventory, checkoutSchema, digitalFileUrl }
 */
app.post('/api/products', async (req, res) => {
  try {
    const {
      sellerId, title, description, price_cents, currency,
      image_url, inventory, checkoutSchema,
      digitalFileUrl // optional public URL
    } = req.body;

    if (!sellerId || !title || !price_cents) {
      return res.status(400).send({ error: 'sellerId, title, and price_cents are required' });
    }

    const productRef = db.collection('products').doc();
    const digitalDownload = digitalFileUrl ? buildDigitalDownloadFromUrl(digitalFileUrl) : null;

    const product = {
      productId: productRef.id,
      sellerId,
      title,
      description: description || '',
      price_cents,
      currency: (currency || 'usd').toLowerCase(),
      image_url: image_url || null,
      inventory: typeof inventory === 'number' ? inventory : null,
      active: true,
      createdAt: new Date().toISOString(),
      checkoutSchema: checkoutSchema || {
        backgroundColor: '#f7fafc',
        buttonColor: '#2563eb',
        textColor: '#0f172a'
      },
      // normalized schema
      digitalDownload: digitalDownload || null,
      hasDigital: Boolean(digitalDownload) // convenience flag
    };

    await productRef.set(product);
    res.json({ product });
  } catch (err) {
    console.error('create product err', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Associate product to seller
 * POST /api/products/:productId/associate
 * body: { sellerId }
 */
app.post('/api/products/:productId/associate', verifyFirebaseToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const { sellerId } = req.body;
    const pRef = db.collection('products').doc(productId);
    const pSnap = await pRef.get();
    if (!pSnap.exists) return res.status(404).send({ error: 'product not found' });

    await pRef.update({ sellerId });
    res.send({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: err.message });
  }
});

/**
 * Create short link
 * POST /api/links
 * body: { productId, sellerId, email, expiresAt, digitalFileUrl }
 */
app.post('/api/links', async (req, res) => {
  try {
    const { productId, sellerId, email, expiresAt, digitalFileUrl } = req.body;
    if (!productId) return res.status(400).send({ error: 'productId required' });

    const productSnap = await db.collection('products').doc(productId).get();
    if (!productSnap.exists) return res.status(404).send({ error: 'product not found' });
    const product = productSnap.data();

    const linkId = nanoid(7).toUpperCase();

    // Use link override if provided, else snapshot product.digitalDownload
    const urlBasedDownload = digitalFileUrl ? buildDigitalDownloadFromUrl(digitalFileUrl) : null;
    const linkDigital = urlBasedDownload || product.digitalDownload || null;

    const hasDigital = Boolean(linkDigital && (linkDigital.storagePath || linkDigital.contentUrl));

    const linkDoc = {
      linkId,
      productId,
      sellerId: sellerId || product.sellerId,
      email: email || null,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt || null,
      digitalDownload: linkDigital, // normalized schema
      hasDigital
    };

    await db.collection('links').doc(linkId).set(linkDoc);

    const baseUrl = process.env.FRONTEND_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
    const pageUrl = `${baseUrl}/p/${linkId}${hasDigital ? '?digital=1' : ''}`;

    res.json({ linkId, pageUrl, onboardingUrl: null, hasDigital });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: err.message });
  }
});

/**
 * Payment page (server-rendered)
 * GET /p/:linkId
 */
app.get('/p/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;
    const linkSnap = await db.collection('links').doc(linkId).get();
    if (!linkSnap.exists) return res.status(404).send('Link not found');
    const link = linkSnap.data();

    const pSnap = await db.collection('products').doc(link.productId).get();
    if (!pSnap.exists) return res.status(404).send('Product not found');
    const product = pSnap.data();

    product.checkoutSchema = product.checkoutSchema || {
      backgroundColor: '#f7fafc',
      buttonColor: '#2563eb',
      textColor: '#0f172a'
    };
    product.price_display = (product.price_cents / 100).toFixed(2);

    let hasDigital = Boolean(
      (link.digitalDownload && (link.digitalDownload.storagePath || link.digitalDownload.contentUrl)) ||
      (product.digitalDownload && (product.digitalDownload.storagePath || product.digitalDownload.contentUrl))
    );
    if (!hasDigital && (req.query.digital === '1' || req.query.digital === 'true')) {
      hasDigital = true;
    }

    const template = fs.readFileSync(path.join(__dirname, 'templates', 'payment_page.mustache'), 'utf8');
    const html = mustache.render(template, { product, link, hasDigital });
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('render page err', err);
    res.status(500).send('Server error');
  }
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { linkId } = req.body;
    if (!linkId) return res.status(400).send({ error: 'linkId required' });

    const linkSnap = await db.collection('links').doc(linkId).get();
    if (!linkSnap.exists) return res.status(404).send({ error: 'link not found' });
    const link = linkSnap.data();

    const productSnap = await db.collection('products').doc(link.productId).get();
    if (!productSnap.exists) return res.status(404).send({ error: 'product not found' });
    const product = productSnap.data();

    const hasDigital = Boolean(
      (link.digitalDownload && (link.digitalDownload.storagePath || link.digitalDownload.contentUrl)) ||
      (product.digitalDownload && (product.digitalDownload.storagePath || product.digitalDownload.contentUrl))
    );

    const origin = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    const successUrl = `${origin}/success?session_id={CHECKOUT_SESSION_ID}${hasDigital ? '&digital=1' : ''}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: product.currency || 'usd',
          unit_amount: product.price_cents,
          product_data: {
            name: product.title,
            description: product.description || undefined,
            images: product.image_url ? [product.image_url] : undefined
          }
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: `${origin}/p/${linkId}`,
      metadata: {
        linkId,
        productId: product.productId,
        sellerId: link.sellerId || product.sellerId
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Create checkout session error:', err);
    res.status(500).send({ error: err.message });
  }
});

/**
 * Seller metrics: Stripe balance + recent payment intents + aggregated orders
 */
app.get('/api/sellers/:sellerId/metrics', verifyFirebaseToken, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const sSnap = await db.collection('sellers').doc(sellerId).get();
    if (!sSnap.exists) return res.status(404).send({ error: 'seller not found' });
    const seller = sSnap.data();
    if (!seller.stripeAccountId) return res.status(400).send({ error: 'seller has no stripe account' });

    // Stripe balance for connected account
    const balance = await stripe.balance.retrieve({ stripeAccount: seller.stripeAccountId });

    // recent payment intents
    const payments = await stripe.paymentIntents.list({ limit: 20, stripeAccount: seller.stripeAccountId });

    // orders aggregation
    const ordersSnap = await db.collection('orders').where('sellerId', '==', sellerId).get();
    const orders = [];
    const salesByProduct = {};
    ordersSnap.forEach(doc => {
      const o = doc.data();
      orders.push(o);
      salesByProduct[o.productId] = salesByProduct[o.productId] || { count: 0, revenue_cents: 0 };
      salesByProduct[o.productId].count += 1;
      salesByProduct[o.productId].revenue_cents += (o.amount_total || 0);
    });

    res.json({
      stripe: {
        balance,
        recentPaymentIntents: payments.data
      },
      orders,
      salesByProduct
    });
  } catch (err) {
    console.error('metrics err', err);
    res.status(500).send({ error: err.message });
  }
});

/**
 * Simple read endpoints
 */
app.get('/api/products/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const pSnap = await db.collection('products').doc(productId).get();
    if (!pSnap.exists) return res.status(404).send({ error: 'product not found' });
    res.json({ product: pSnap.data() });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: err.message });
  }
});

app.get('/api/sellers/:sellerId', async (req, res) => {
  try {
    const { sellerId } = req.params;
    const sSnap = await db.collection('sellers').doc(sellerId).get();
    if (!sSnap.exists) return res.status(404).send({ error: 'seller not found' });
    res.json({ seller: sSnap.data() });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: err.message });
  }
});

/**
 * Seed random product (for testing)
 * POST /api/seed/product
 * body: { sellerId } (optional - will generate random if not provided)
 */
app.post('/api/seed/product', async (req, res) => {
  try {
    const { sellerId = nanoid(10) } = req.body;
    
    const mockTitles = [
      'Premium Wireless Headphones',
      'Smart Fitness Watch',
      'Portable Power Bank',
      'Ergonomic Mouse',
      'Mechanical Keyboard'
    ];
    
    const mockDescriptions = [
      'High-quality product with premium features',
      'Perfect for everyday use',
      'Best-in-class performance',
      'Innovative design and functionality',
      'Professional grade equipment'
    ];

    const productRef = db.collection('products').doc();
    const product = {
      productId: productRef.id,
      sellerId,
      title: mockTitles[Math.floor(Math.random() * mockTitles.length)],
      description: mockDescriptions[Math.floor(Math.random() * mockDescriptions.length)],
      price_cents: Math.floor(Math.random() * 20000) + 1000, // Random price between $10-$200
      currency: 'usd',
      image_url: `https://picsum.photos/seed/${productRef.id}/400/400`,
      inventory: Math.floor(Math.random() * 50) + 1,
      active: true,
      createdAt: new Date().toISOString()
    };

    await productRef.set(product);
    res.json({ product });
  } catch (err) {
    console.error('seed product err', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Seed random link (for testing)
 * POST /api/seed/link
 * body: { productId } (optional - will use random product if not provided)
 */
app.post('/api/seed/link', async (req, res) => {
  try {
    let { productId } = req.body;
    
    // If no productId provided, get a random product from the database
    if (!productId) {
      const productsSnap = await db.collection('products').limit(1).get();
      if (productsSnap.empty) {
        return res.status(404).send({ error: 'no products found to create link' });
      }
      const randomProduct = productsSnap.docs[0];
      productId = randomProduct.id; // Use document ID directly
    }

    // Verify product exists
    const productSnap = await db.collection('products').doc(productId).get();
    if (!productSnap.exists) {
      return res.status(404).send({ error: 'product not found' });
    }

    const linkId = nanoid(7).toUpperCase();
    const now = new Date();
    
    // Random expiry between 1 day and 30 days from now
    const randomDays = Math.floor(Math.random() * 29) + 1;
    const expiresAt = new Date(now.getTime() + (randomDays * 24 * 60 * 60 * 1000)).toISOString();

    const linkDoc = {
      linkId,
      productId,
      createdAt: now.toISOString(),
      expiresAt,
      active: true
    };

    await db.collection('links').doc(linkId).set(linkDoc);
    const pageUrl = `${process.env.FRONTEND_BASE_URL || `http://localhost:${process.env.PORT || 4000}`}/p/${linkId}`;
    
    res.json({ 
      link: linkDoc,
      pageUrl
    });
  } catch (err) {
    console.error('seed link err', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Seed random seller (for testing)
 * POST /api/seed/seller
 * body: { email } (optional - will generate random if not provided)
 */
app.post('/api/seed/seller', async (req, res) => {
  try {
    const mockBusinessTypes = ['individual', 'company'];
    const mockCountries = ['US', 'GB', 'CA', 'AU'];
    const mockBusinessNames = [
      'Tech Solutions Inc',
      'Digital Innovations',
      'Smart Gadgets Co',
      'Future Electronics',
      'Modern Tech Store'
    ];

    let { email } = req.body;
    if (!email) {
      // Generate random email if not provided
      const randomId = nanoid(6);
      email = `seller${randomId}@example.com`;
    }

    // Create Stripe Connected Account
    const account = await stripe.accounts.create({
      type: 'express',
      country: "US",
      email: email,
      business_type: mockBusinessTypes[Math.floor(Math.random() * mockBusinessTypes.length)],
      business_profile: {
        name: mockBusinessNames[Math.floor(Math.random() * mockBusinessNames.length)],
        // url: `https://example.com/${nanoid(8)}`
      },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      }
    });

    // Create seller document
    const sellerId = nanoid(10);
    const sellerDoc = {
      sellerId,
      email,
      stripeAccountId: account.id,
      stripeAccountStatus: account.capabilities || {},
      businessProfile: account.business_profile,
      country: account.country,
      createdAt: new Date().toISOString(),
      active: true
    };

    await db.collection('sellers').doc(sellerId).set(sellerDoc);

    // Create account link for onboarding
    const origin = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${origin}/refresh?sellerId=${sellerId}`,
      return_url: `${origin}/success?sellerId=${sellerId}`,
      type: 'account_onboarding'
    });

    res.json({
      seller: sellerDoc,
      stripeAccountId: account.id,
      accountLink: accountLink.url
    });

  } catch (err) {
    console.error('seed seller err', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload a digital file scoped to a product
app.post('/api/products/:productId/digital', bodyParser.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  try {
    const { productId } = req.params;
    if (!productId) return res.status(400).json({ error: 'productId required' });

    // Ensure product exists
    const pSnap = await db.collection('products').doc(productId).get();
    if (!pSnap.exists) return res.status(404).json({ error: `product not found: ${productId}` });

    if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file uploaded' });

    console.log(`Uploading digital file for product ${productId}, size: ${req.body.length} bytes`);

    const contentType = req.headers['content-type'] || 'application/octet-stream';
    const rawName = decodeURIComponent(req.headers['x-filename'] || `digital-${Date.now()}`);
    const fileName = sanitizeFilename(rawName);
    const storagePath = `downloads/${productId}/${Date.now()}-${fileName}`;

    // save buffer to GCS
    await bucket.file(storagePath).save(req.body, {
      metadata: { contentType, cacheControl: 'private, max-age=0, no-transform' }
    });

    console.log(`Digital file uploaded: ${storagePath}`);

    const fileSize = Buffer.isBuffer(req.body) ? req.body.length : undefined;

    const digitalDownload = {
      fileName,
      contentType,
      storagePath,
      fileSize,
      updatedAt: new Date().toISOString()
    };

    console.log('Digital download metadata:', digitalDownload);

    await db.collection('products').doc(productId).update({ digitalDownload });

    return res.json({ digitalDownload });
  } catch (err) {
    console.error('Upload digital error:', err);
    return res.status(500).json({ error: `Failed to upload digital file: ${err.message}` });
  }
});

// Handles any requests that don't match the API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build/index.html'));
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
