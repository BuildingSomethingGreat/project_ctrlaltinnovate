import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { styles } from '../styles/shared';
import { resolveSeller, getSellerSummary, getSellerLedger, requestPayout } from '../utils/api';

function fmtUSD(cents) {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

function stripeFee(cents) {
  return Math.round((cents || 0) * 0.029) + 30;
}

function platformFee(cents) {
  return Math.round((cents || 0) * 0.05);
}

function netAfterFees(cents) {
  return Math.max(0, (cents || 0) - stripeFee(cents) - platformFee(cents));
}

export default function SellerDashboard() {
  const [searchParams] = useSearchParams();
  const emailFromQuery = searchParams.get('email') || '';
  const [seller, setSeller] = useState(null);
  const [summary, setSummary] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [loading, setLoading] = useState(true);
  const [payoutLoading, setPayoutLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  useEffect(() => {
    async function init() {
      try {
        setLoading(true);
        let s = null;
        if (emailFromQuery) {
          const res = await resolveSeller(emailFromQuery);
          s = res.seller;
        }
        if (!s || !s.sellerId) {
          setError('Seller not found or not verified.');
          setLoading(false);
          return;
        }
        setSeller(s);
        const sum = await getSellerSummary(s.sellerId);
        setSummary(sum);
        const led = await getSellerLedger(s.sellerId, 20);
        setLedger(led.items || []);
      } catch (e) {
        setError(e.message || 'Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [emailFromQuery]);

  const onPayout = async () => {
    if (!seller) return;
    setPayoutLoading(true);
    setToast('Submitting payout request…');
    try {
      const r = await requestPayout(seller.sellerId);
      setToast('Payout request submitted.');
      const sum = await getSellerSummary(seller.sellerId);
      setSummary(sum);
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      setToast(`Error: ${e.message}`);
      setTimeout(() => setToast(null), 5000);
    } finally {
      setPayoutLoading(false);
    }
  };

  if (loading) return <div style={styles.card}>Loading…</div>;
  if (error) return <div style={styles.card}>Error: {error}</div>;

  const available = summary?.balance?.available_cents || 0;
  const lastPayoutAt = summary?.payouts?.lastPayoutAt;
  const net = netAfterFees(available);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={styles.title}>InstaPay — Seller Dashboard</h1>

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            background: '#166534',
            color: '#fff',
            padding: '10px 14px',
            borderRadius: 8,
            boxShadow: '0 4px 12px rgba(0,0,0,.15)',
            fontSize: 14
          }}
        >
          {toast}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16, marginTop: 12 }}>
        <div style={styles.card}>
          <div style={styles.small}>Gross Balance</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{fmtUSD(available)}</div>
          <div style={styles.small} title="Estimated after Stripe + platform fees">
            Net After Fees: <strong>{fmtUSD(net)}</strong>
          </div>
          <button
            style={{ ...styles.button, marginTop: 12, opacity: available > 0 && !payoutLoading ? 1 : 0.6 }}
            disabled={available <= 0 || payoutLoading}
            onClick={onPayout}
          >
            {payoutLoading ? 'Requesting…' : 'Request Payout'}
          </button>
          {lastPayoutAt && <div style={styles.small}>Last payout: {new Date(lastPayoutAt).toLocaleString()}</div>}
        </div>

        <div style={styles.card}>
          <div style={styles.small}>Products</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{summary?.stats?.products || 0}</div>
        </div>

        <div style={styles.card}>
          <div style={styles.small}>Payment Links</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{summary?.stats?.links || 0}</div>
        </div>
      </div>

      <div style={{ ...styles.card, marginTop: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Recent Activity</div>
        {ledger.length === 0 && <div style={styles.small}>No recent activity</div>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {ledger.map((e) => (
            <li key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee' }}>
              <div>
                <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{(e.type || '').replace('.', ' · ')}</div>
                <div style={styles.small}>{new Date(e.createdAt).toLocaleString()}</div>
              </div>
              <div style={{ fontWeight: 600 }}>{e.amount_cents ? fmtUSD(e.amount_cents) : ''}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}