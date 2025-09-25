# Stripe Connect + Firebase API (Express)

This repository is an Express backend that integrates Stripe Connect (Express accounts) with Firebase Firestore to:
- Onboard connected accounts (Express)
- Create products associated to sellers
- Create short payment links
- Render a minimal payment page for a link
- Create Stripe Checkout Sessions (payments routed to connected accounts)
- Receive Stripe webhooks and record orders
- Provide metrics (Stripe + Firestore)

## Requirements
- Node 18+ / npm
- Stripe account (test keys)
- Firebase project with a service-account JSON (we use environment vars)

## Setup
1. Clone/copy this project.
2. `npm install`
3. Copy `.env.example` to `.env` and fill values.
   - Make sure `FIREBASE_PRIVATE_KEY` newlines are escaped (`\n`) or wrap properly.
4. Create the `templates` folder (already included) and ensure `payment_page.mustache` exists.
5. Start server:
