import React, { useEffect, useState } from 'react';
import { resolveSeller } from '../utils/api';

export default function DashboardButton({ email, sellerId: sellerIdProp }) {
  const [seller, setSeller] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function run() {
      if (sellerIdProp) {
        setSeller({ sellerId: sellerIdProp, emailVerified: true });
        return;
      }
      if (!email) return;
      setLoading(true);
      try {
        const res = await resolveSeller(email);
        if (!ignore) setSeller(res.seller || null);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    run();
    return () => { ignore = true; };
  }, [email, sellerIdProp]);

  const sellerId = seller?.sellerId;
  const verified = !!seller?.emailVerified;

  if (loading) return null;
  if (!sellerId || !verified) return null;

  return (
    <button
      type="button"
      onClick={() => { window.location.href = `/dashboard/${sellerId}`; }}
      style={{
        background: '#22c55e', color: '#fff', border: 'none',
        padding: '10px 14px', borderRadius: 8, fontWeight: 600, cursor: 'pointer'
      }}
      aria-label="Open dashboard"
      title="Open dashboard"
    >
      Open Dashboard
    </button>
  );
}