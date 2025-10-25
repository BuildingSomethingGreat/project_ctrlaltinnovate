import React from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { styles } from '../styles/shared';

function PaymentSuccess() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const isDigital = searchParams.get('digital') === '1' || searchParams.get('digital') === 'true';

  return (
    <div style={styles.card}>
      <h1 style={styles.title}>Payment Successful!</h1>
      <p style={styles.description}>Thank you for your purchase.</p>
      {isDigital && (
        <p style={styles.description}>
          Your downloadable file is being processed and will be delivered within 24 hours.
        </p>
      )}
      {/* <p style={styles.small}>Session ID: {sessionId}</p> */}
      {/* <Link to="/">
        <button style={styles.button}>
          Create Another Payment Link
        </button>
      </Link> */}
    </div>
  );
}

export default PaymentSuccess;