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
// const { generateEmailTemplate } = require('./utils/emailTemplate');

// Update email template branding: header logo, green accents, default app name "InstaPay"
function generateEmailTemplate({ appName = 'InstaPay', title, message, details }) {
  const publicBase = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
  const brandLogo = `${publicBase}/white-logo-full.png`;
  const accent = '#16a34a'; // medium green

  return `
  <div style="background:#f6f9fc;padding:24px;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr>
        <td style="padding:24px 24px 8px 24px;text-align:center;">
          <img src="${brandLogo}" alt="${appName}" style="width:180px;max-width:80%;height:auto;display:block;margin:0 auto 8px;" />
        </td>
      </tr>
      <tr>
        <td style="padding:0 24px 8px 24px;">
          <h1 style="margin:0;font-family:Inter,Arial,sans-serif;font-size:20px;line-height:28px;color:#0f172a;">${title || ''}</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:0 24px 16px 24px;">
          <div style="font-family:Inter,Arial,sans-serif;font-size:14px;line-height:22px;color:#334155;">${message || ''}</div>
        </td>
      </tr>
      ${details ? `
      <tr>
        <td style="padding:0 24px 24px 24px;">
          <div style="font-family:Inter,Arial,sans-serif;font-size:14px;line-height:22px;color:#334155;">${details}</div>
        </td>
      </tr>` : ''}
      <tr>
        <td style="padding:16px 24px 24px 24px;">
          <div style="height:1px;background:${accent};opacity:0.3;"></div>
          <div style="text-align:center;margin-top:12px;font-family:Inter,Arial,sans-serif;font-size:12px;color:#64748b;">
            Sent with <span style="color:${accent};font-weight:600;">${appName}</span>
          </div>
        </td>
      </tr>
    </table>
  </div>`;
}

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
  const map = { pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', zip:'application/zip', txt:'text/plain' };
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

// Helper: fetch a public URL and stage it into Storage, returning a digitalDownload object
async function stageRemoteUrlToStorage({ productId, url, linkId }) {
  if (!productId || !url) throw new Error('productId and url are required');

  const doFetch = global.fetch ? global.fetch.bind(global) : (await import('node-fetch')).default;
  const u = new URL(url);
  const rawName = decodeURIComponent(u.pathname.split('/').pop() || 'download');
  const fileName = sanitizeFilename(rawName);
  const resp = await doFetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch digital file from URL (${resp.status})`);

  const ab = await resp.arrayBuffer();
  const buffer = Buffer.from(ab);
  const contentType = resp.headers.get('content-type') || guessContentTypeFromExt(fileName);
  const ts = Date.now();
  const idSeg = linkId ? `${linkId}-` : '';
  const storagePath = `downloads/${productId}/${idSeg}${ts}-${fileName}`;

  await bucket.file(storagePath).save(buffer, {
    metadata: { contentType, cacheControl: 'private, max-age=0, no-transform' }
  });

  return {
    fileName,
    contentType,
    storagePath,
    fileSize: buffer.length,
    updatedAt: new Date().toISOString(),
    contentUrl: url // keep for reference
  };
}

function baseUrl() {
  return process.env.FRONTEND_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
}

async function findSellerByEmail(email) {
  const snap = await db.collection('sellers').where('email', '==', String(email).toLowerCase()).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

const app = express();

// Serve static files from the React frontend app
app.use(express.static(path.join(__dirname, '../frontend/build')));

// Webhook stays BEFORE JSON parsing (needs raw body)
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

// Enable CORS and JSON parsing for all other routes
app.use(cors());
app.use(bodyParser.json());

// Moved below body parser: getEmailFromReq + seller auth/resolve routes
function getEmailFromReq(req) {
  const b = req.body || {};
  const q = req.query || {};
  const h = req.headers || {};
  const email =
    b.email ||
    b.sellerEmail ||
    b.userEmail ||
    q.email ||
    q.sellerEmail ||
    q.userEmail ||
    h['x-email'] ||
    h['x-user-email'];
  return typeof email === 'string' ? email.toLowerCase().trim() : '';
}

// Request magic link (create seller if not exists; do NOT duplicate existing emails)
app.post('/api/sellers/request-magic-link', async (req, res) => {
  try {
    const email = getEmailFromReq(req);
    if (!email) return res.status(400).json({ error: 'email required' });

    let seller = await findSellerByEmail(email);
    if (!seller) {
      const sellerId = nanoid(12);
      const doc = { sellerId, email, emailVerified: false, createdAt: new Date().toISOString() };
      await db.collection('sellers').doc(sellerId).set(doc);
      seller = doc;
    }

    const token = nanoid(48);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await db.collection('emailTokens').doc(token).set({
      token, email, sellerId: seller.sellerId, expiresAt, used: false, createdAt: new Date().toISOString()
    });

    const verifyUrl = `${baseUrl()}/api/auth/magic/verify?token=${encodeURIComponent(token)}`;
    const html = generateEmailTemplate({
      appName: 'InstaPay',
      title: 'Verify your email',
      message: 'Click the button below to verify your email and start creating payment links.',
      details: `<a href="${verifyUrl}" style="display:inline-block;padding:10px 16px;background:#16a34a;color:#fff;border-radius:6px;text-decoration:none;">Verify Email</a>
                <div style="margin-top:8px;font-size:12px;color:#6b7280;">This link expires in 15 minutes.</div>`
    });

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'no-reply@instapay.app',
      to: email,
      subject: 'Verify your email for InstaPay',
      html
    });

    return res.json({ ok: true, sellerId: seller.sellerId, emailed: true });
  } catch (err) {
    console.error('request-magic-link err', err);
    res.status(500).json({ error: err.message });
  }
});

// Verify magic token, mark seller verified, then redirect to frontend
app.get('/api/auth/magic/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Missing token');

    const tRef = db.collection('emailTokens').doc(String(token));
    const tSnap = await tRef.get();
    if (!tSnap.exists) return res.status(400).send('Invalid token');

    const t = tSnap.data();
    if (t.used) return res.status(400).send('Token already used');
    if (new Date(t.expiresAt).getTime() < Date.now()) return res.status(400).send('Token expired');

    await tRef.update({ used: true, usedAt: new Date().toISOString() });
    await db.collection('sellers').doc(t.sellerId).set(
      { emailVerified: true, emailVerifiedAt: new Date().toISOString() },
      { merge: true }
    );

    const redirectTo = `${baseUrl()}/verified.html?verified=1&email=${encodeURIComponent(t.email)}`;
    return res.redirect(302, redirectTo);
  } catch (err) {
    console.error('magic verify err', err);
    res.status(500).send('Server error');
  }
});

// Resolve seller by email (de-duplicate: reuse existing sellerId)
app.get('/api/sellers/resolve', async (req, res) => {
  try {
    const email = getEmailFromReq(req);
    if (!email) return res.status(400).json({ error: 'email required' });
    const seller = await findSellerByEmail(email);
    if (!seller) return res.json({ seller: null });
    return res.json({
      seller: {
        sellerId: seller.sellerId || seller.id,
        email: seller.email,
        emailVerified: !!seller.emailVerified
      }
    });
  } catch (err) {
    console.error('resolve seller err', err);
    res.status(500).json({ error: err.message });
  }
});

// Guard helpers
async function requireVerifiedSellerById(sellerId) {
  const snap = await db.collection('sellers').doc(String(sellerId)).get();
  if (!snap.exists) return { ok: false, code: 'NOT_FOUND' };
  const s = snap.data();
  if (!s.emailVerified) return { ok: false, code: 'EMAIL_NOT_VERIFIED', seller: s };
  return { ok: true, seller: s };
}

async function resolveVerifiedSellerFromEmailOrId({ email, sellerId }) {
  if (sellerId) return requireVerifiedSellerById(sellerId);
  if (email) {
    const s = await findSellerByEmail(email);
    if (!s) return { ok: false, code: 'NOT_FOUND' };
    if (!s.emailVerified) return { ok: false, code: 'EMAIL_NOT_VERIFIED', seller: s };
    return { ok: true, seller: s };
  }
  return { ok: false, code: 'MISSING_SELLER' };
}

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

    // ADD: normalize digital (fallback to legacy digitalFileUrl)
    const digital =
      product.digitalDownload ||
      link?.digitalDownload ||
      (product.digitalFileUrl ? buildDigitalDownloadFromUrl(product.digitalFileUrl) : null) ||
      (link?.digitalFileUrl ? buildDigitalDownloadFromUrl(link.digitalFileUrl) : null);

    if (!digital) return false;

    const buyerEmail = session.customer_details?.email || session.customer_email || null;
    if (!buyerEmail) return false;

    // Prepare attachment from storagePath or contentUrl
    let attachment = null;

    if (digital.storagePath) {
      const fileRef = bucket.file(digital.storagePath);
      const [buffer] = await fileRef.download();
      const base64 = Buffer.from(buffer).toString('base64'); // Resend expects base64
      attachment = {
        filename: digital.fileName || 'download',
        content: base64,
        contentType: digital.contentType || 'application/octet-stream'
      };
    } else if (digital.contentUrl) {
      // Explicit fetch with Node 18+ or dynamic import fallback
      const doFetch = global.fetch ? global.fetch.bind(global) : (await import('node-fetch')).default;
      const resp = await doFetch(digital.contentUrl);
      if (resp.ok) {
        const ab = await resp.arrayBuffer();
        const buffer = Buffer.from(ab);
        const base64 = buffer.toString('base64'); // Resend expects base64
        attachment = {
          filename: digital.fileName || 'download',
          content: base64,
          contentType: digital.contentType || resp.headers.get('content-type') || 'application/octet-stream'
        };
      } else {
        console.warn('Failed to fetch contentUrl for attachment:', digital.contentUrl, resp.status);
      }
    }

    const buyerHtml = generateEmailTemplate({
      appName: 'InstaPay',
      title: 'Your download is ready',
      message: `Thanks for your purchase of <strong>${product.title}</strong>. Your file is attached.`,
      details: `
        ${product.image_url ? `<img src="${product.image_url}" alt="${product.title}" style="max-width:100%; border-radius:8px; margin-bottom:12px;" />` : ''}
        <div>Order total: ${formatPrice(session.amount_total, product.currency || 'usd')}</div>
        ${(!attachment && digital.contentUrl) ? `<div style="margin-top:8px;">If the attachment is missing, you can also download your file here: <a href="${digital.contentUrl}">${digital.contentUrl}</a></div>` : ''}
      `
    });

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'no-reply@instapay.app',
      to: buyerEmail,
      subject: `Your ${product.title} download`,
      html: buyerHtml,
      ...(attachment ? { attachments: [attachment] } : {})
    });

    const sellerHtml = generateEmailTemplate({
      appName: 'InstaPay',
      title: 'Your order was automatically fulfilled',
      message: `An order for <strong>${product.title}</strong> was automatically fulfilled via digital delivery.`,
      details: `
        <div>Buyer: ${buyerEmail}</div>
        <div>Amount: ${formatPrice(session.amount_total, product.currency || 'usd')}</div>
        ${product.image_url ? `<div style="margin-top:12px;"><img src="${product.image_url}" alt="${product.title}" style="max-width:100%; border-radius:8px;" /></div>` : ''}
      `
    });

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'no-reply@instapay.app',
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
      sellerId, email, title, description, price_cents, currency,
      image_url, inventory, checkoutSchema,
      digitalFileUrl // optional
    } = req.body;

    const check = await resolveVerifiedSellerFromEmailOrId({ email: email?.toLowerCase?.(), sellerId });
    if (!check.ok) {
      if (check.code === 'EMAIL_NOT_VERIFIED' || check.code === 'NOT_FOUND') {
        return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED', requiresEmailVerification: true });
      }
      return res.status(400).json({ error: 'seller required' });
    }

    const productRef = db.collection('products').doc();

    // Optional: stage remote digital file if provided (existing helper)
    let digitalDownload = null;
    if (digitalFileUrl) {
      try {
        digitalDownload = await stageRemoteUrlToStorage({
          productId: productRef.id,
          url: digitalFileUrl
        });
      } catch (e) {
        console.error('Failed to stage digitalFileUrl to storage:', e);
        return res.status(400).json({ error: 'Could not fetch digitalFileUrl' });
      }
    }

    const product = {
      productId: productRef.id,
      sellerId: check.seller.sellerId || check.seller.id,
      title,
      description: description || '',
      // price_cents is now optional to support auction-only flows
      price_cents: Number.isInteger(price_cents) ? price_cents : null,
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
      digitalDownload,
      hasDigital: Boolean(digitalDownload)
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
 * body: { productId, sellerId, email, expiresAt, digitalFileUrl, auction?: { enabled, endsAt, startingPrice_cents, minIncrement_cents } }
 */
app.post('/api/links', async (req, res) => {
  try {
    const { productId, sellerId, email, expiresAt, digitalFileUrl, auction } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId required' });

    const check = await resolveVerifiedSellerFromEmailOrId({ email: email?.toLowerCase?.(), sellerId });
    if (!check.ok) {
      if (check.code === 'EMAIL_NOT_VERIFIED' || check.code === 'NOT_FOUND') {
        return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED', requiresEmailVerification: true });
      }
      return res.status(400).json({ error: 'seller required' });
    }

    const productSnap = await db.collection('products').doc(productId).get();
    if (!productSnap.exists) return res.status(404).json({ error: 'product not found' });
    const product = productSnap.data();

    const linkId = nanoid(7).toUpperCase();

    // Stage link-level digital if provided, else snapshot product
    let linkDigital = null;
    if (digitalFileUrl) {
      try {
        linkDigital = await stageRemoteUrlToStorage({
          productId,
          url: digitalFileUrl,
          linkId
        });
      } catch (e) {
        console.error('Failed to stage link digitalFileUrl to storage:', e);
        return res.status(400).json({ error: 'Could not fetch link digitalFileUrl' });
      }
    } else {
      linkDigital = product.digitalDownload || null;
    }
    const hasDigital = Boolean(linkDigital && (linkDigital.storagePath || linkDigital.contentUrl));

    // Auction config
    let auctionCfg = null;
    if (auction?.enabled) {
      if (!auction.endsAt) return res.status(400).json({ error: 'auction.endsAt required when auction.enabled' });
      const endsAtIso = new Date(auction.endsAt).toISOString();
      auctionCfg = {
        enabled: true,
        endsAt: endsAtIso,
        startingPrice_cents: Number.isInteger(auction.startingPrice_cents) ? auction.startingPrice_cents : (product.price_cents || 0),
        minIncrement_cents: Number.isInteger(auction.minIncrement_cents) ? auction.minIncrement_cents : 100,
        status: 'active'
      };
    }

    const linkDoc = {
      linkId,
      productId,
      sellerId: check.seller.sellerId || check.seller.id,
      email: check.seller.email,
      createdAt: new Date().toISOString(),
      // If auction provided, force expiresAt to endsAt
      expiresAt: auctionCfg?.endsAt || expiresAt || null,
      digitalDownload: linkDigital,
      hasDigital,
      ...(auctionCfg ? { auction: auctionCfg } : {})
    };

    await db.collection('links').doc(linkId).set(linkDoc);

    const pageUrl = `${baseUrl()}/p/${linkId}${hasDigital ? '?digital=1' : ''}`;

    res.json({ linkId, pageUrl, hasDigital, auction: auctionCfg || null });
  } catch (err) {
    console.error('Error creating payment link:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Auction helpers ---
async function getHighestBid(linkId) {
  const bidsSnap = await db.collection('links').doc(linkId).collection('bids')
    .orderBy('amount_cents', 'desc').limit(1).get();
  if (bidsSnap.empty) return null;
  const doc = bidsSnap.docs[0];
  return { bidId: doc.id, ...doc.data() };
}

async function finalizeAuction(link) {
  if (!link?.auction?.enabled) return null;
  if (link.auction.status === 'finalized') return link;

  const now = new Date();
  const ended = new Date(link.auction.endsAt) <= now;
  if (!ended) return link;

  const highest = await getHighestBid(link.linkId);
  const winner = highest ? { email: highest.email, bidId: highest.bidId, amount_cents: highest.amount_cents } : null;

  // Persist finalization
  await db.collection('links').doc(link.linkId).update({
    'auction.status': 'finalized',
    'auction.winner': winner || null,
    active: false
  });

  // If winner exists, create a standard purchase link and email them
  if (winner) {
    try {
      const pSnap = await db.collection('products').doc(link.productId).get();
      const product = pSnap.data();
      const sSnap = await db.collection('sellers').doc(link.sellerId).get();
      const seller = sSnap.data();

      // Create winner-only purchase link valid for 48h
      const winnerLinkId = nanoid(7).toUpperCase();
      const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
      const winnerLinkDoc = {
        linkId: winnerLinkId,
        productId: link.productId,
        sellerId: link.sellerId,
        createdAt: new Date().toISOString(),
        expiresAt,
        // snapshot digital if any
        digitalDownload: link.digitalDownload || product.digitalDownload || null,
        hasDigital: Boolean((link.digitalDownload && (link.digitalDownload.storagePath || link.digitalDownload.contentUrl)) ||
          (product.digitalDownload && (product.digitalDownload.storagePath || product.digitalDownload.contentUrl)))
      };
      await db.collection('links').doc(winnerLinkId).set(winnerLinkDoc);
      const baseUrl = process.env.FRONTEND_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
      const winnerPageUrl = `${baseUrl}/p/${winnerLinkId}${winnerLinkDoc.hasDigital ? '?digital=1' : ''}`;

      // Email winner with payment link
      const emailHtml = generateEmailTemplate({
        appName: 'InstaPay',
        title: 'You won the auction!',
        message: `Congrats! You won the auction for <strong>${product.title}</strong> with a bid of $${(winner.amount_cents / 100).toFixed(2)}.`,
        details: `<a href="${winnerPageUrl}" style="color:#16a34a;font-weight:600;">Complete your purchase</a><div style="margin-top:8px;">Link expires: ${new Date(expiresAt).toLocaleString()}</div>`
      });
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'no-reply@instapay.app',
        to: winner.email,
        subject: 'You won the auction!',
        html: emailHtml
      });
    } catch (e) {
      console.error('Failed to email auction winner:', e);
    }
  }

  const updated = await db.collection('links').doc(link.linkId).get();
  return updated.data();
}

// --- Auction routes ---

/**
 * Place a bid
 * POST /api/bids
 * body: { linkId, email, amount_cents }
 */
app.post('/api/bids', async (req, res) => {
  try {
    const { linkId, email, amount_cents } = req.body;
    if (!linkId || !email || !Number.isInteger(amount_cents)) {
      return res.status(400).json({ error: 'linkId, email, amount_cents required' });
    }

    const lRef = db.collection('links').doc(linkId);
    const lSnap = await lRef.get();
    if (!lSnap.exists) return res.status(404).json({ error: 'link not found' });
    let link = lSnap.data();

    if (!link.auction?.enabled) return res.status(400).json({ error: 'auction not enabled for this link' });

    // Expiration check and finalize if needed
    const now = new Date();
    const ended = new Date(link.auction.endsAt) <= now;
    if (ended) {
      link = await finalizeAuction(link);
      return res.status(400).json({ error: 'auction ended', auction: link.auction });
    }

    const highest = await getHighestBid(linkId);
    const minRequired = highest
      ? highest.amount_cents + (link.auction.minIncrement_cents || 100)
      : (link.auction.startingPrice_cents || 0);

    if (amount_cents < minRequired) {
      return res.status(400).json({ error: `minimum bid is ${minRequired}`, minRequired_cents: minRequired, highest_cents: highest?.amount_cents || 0 });
    }

    const bidId = nanoid(10);
    const bidDoc = {
      bidId,
      email: String(email).toLowerCase(),
      amount_cents,
      createdAt: new Date().toISOString()
    };

    await lRef.collection('bids').doc(bidId).set(bidDoc);
    return res.json({ ok: true, bid: bidDoc });
  } catch (err) {
    console.error('place bid err', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get auction summary
 * GET /api/bids/:linkId/summary
 */
app.get('/api/bids/:linkId/summary', async (req, res) => {
  try {
    const { linkId } = req.params;
    const lRef = db.collection('links').doc(linkId);
    const lSnap = await lRef.get();
    if (!lSnap.exists) return res.status(404).json({ error: 'link not found' });
    let link = lSnap.data();

    if (!link.auction?.enabled) return res.status(400).json({ error: 'auction not enabled for this link' });

    // If ended but not finalized, finalize now
    const now = new Date();
    if (new Date(link.auction.endsAt) <= now && link.auction.status !== 'finalized') {
      link = await finalizeAuction(link);
    }

    // Count + highest
    const bidsSnap = await lRef.collection('bids').orderBy('createdAt', 'desc').limit(10).get();
    const bids = bidsSnap.docs.map(d => d.data());
    const highest = await getHighestBid(linkId);

    return res.json({
      auction: link.auction,
      highest_cents: highest?.amount_cents || 0,
      highest_email_masked: highest ? (highest.email.replace(/(.{2}).+(@.+)/, '$1****$2')) : null,
      count: (await lRef.collection('bids').count().get()).data().count || bids.length,
      recent: bids
    });
  } catch (err) {
    console.error('summary err', err);
    res.status(500).json({ error: err.message });
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
    product.price_display = (product.price_cents ? product.price_cents : 0) > 0
      ? (product.price_cents / 100).toFixed(2)
      : (link.auction?.startingPrice_cents ? (link.auction.startingPrice_cents / 100).toFixed(2) : '0.00');

    let hasDigital = Boolean(
      (link.digitalDownload && (link.digitalDownload.storagePath || link.digitalDownload.contentUrl)) ||
      (product.digitalDownload && (product.digitalDownload.storagePath || product.digitalDownload.contentUrl))
    );
    if (!hasDigital && (req.query.digital === '1' || req.query.digital === 'true')) {
      hasDigital = true;
    }

    // Brand assets (served by frontend public folder)
    const publicBase = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    const brand = {
      name: 'InstaPay',
      textUrl: `${publicBase}/instapay-logo-text.png`,
      emailLogoUrl: `${publicBase}/white-logo-full.png`,
      accentColor: '#16a34a' // medium green
    };

    const legal = {
      // UPDATED: point privacy link to frontend static page
      privacyUrl: `${publicBase}/privacy`
    };

    const template = fs.readFileSync(path.join(__dirname, 'templates', 'payment_page.mustache'), 'utf8');
    const html = mustache.render(template, { product, link, hasDigital, brand, legal });
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

    // Enforce expiration for any link
    if (link.expiresAt && new Date(link.expiresAt) <= new Date()) {
      return res.status(400).json({ error: 'This link has expired.' });
    }

    const pSnap = await db.collection('products').doc(link.productId).get();
    if (!pSnap.exists) return res.status(404).send({ error: 'product not found' });
    const product = pSnap.data();

    // If auction is active, block checkout (buy is hidden on page)
    if (link.auction?.enabled && link.auction.status !== 'finalized') {
      return res.status(400).json({ error: 'Auction is active; checkout will be available after the bid closes.' });
    }

    // Determine amount (supports finalized auctions using highest bid; otherwise product price)
    let unitAmount = product.price_cents || null;
    if (link.auction?.enabled && link.auction.status === 'finalized') {
      const highest = await db.collection('links').doc(linkId).collection('bids')
        .orderBy('amount_cents', 'desc').limit(1).get();
      const top = highest.empty ? null : highest.docs[0].data();
      if (!top?.amount_cents) return res.status(400).json({ error: 'No winning bid found for finalized auction.' });
      unitAmount = top.amount_cents;
    }
    if (!Number.isInteger(unitAmount) || unitAmount <= 0) {
      return res.status(400).json({ error: 'Price is missing or invalid for checkout.' });
    }

    const hasDigital = Boolean(
      (link.digitalDownload && (link.digitalDownload.storagePath || link.digitalDownload.contentUrl)) ||
      (product.digitalDownload && (product.digitalDownload.storagePath || product.digitalDownload.contentUrl))
    );

    const origin = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    const successUrl = `${origin}/success?session_id={CHECKOUT_SESSION_ID}${hasDigital ? '&digital=1' : ''}`;

    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: product.currency || 'usd',
          unit_amount: unitAmount,
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
      payment_intent_data: {
        metadata: {
          linkId,
          productId: product.productId,
          sellerId: link.sellerId || product.sellerId
        }
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout session error:', err);
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
