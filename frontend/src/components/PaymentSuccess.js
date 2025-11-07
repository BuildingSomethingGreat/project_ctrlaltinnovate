import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { styles } from '../styles/shared';

function PaymentSuccess() {
  const [searchParams] = useSearchParams();
  const isDigital = searchParams.get('digital') === '1' || searchParams.get('digital') === 'true';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={styles.card}>
        <h1 style={styles.title}>Payment Successful!</h1>
        <p style={styles.description}>Thank you for your purchase.</p>
        {isDigital && (
          <p style={styles.description}>
            Your downloadable file is being processed and will be delivered within 24 hours.
          </p>
        )}
        {/* <p style={styles.small}>Session ID: {searchParams.get('session_id')}</p> */}
        {/* <Link to="/"><button style={styles.button}>Create Another Payment Link</button></Link> */}
      </div>

      <p style={styles.small}>
        <span style={{ color: 'rgba(0,0,0,.5)' }}>
          InstaPay copyright © 2025. Created by Edwards Technology and Affiliates
        </span>{' '}
        ♥️.
      </p>
      <a
        href="/privacy.html"
        target="_blank"
        rel="noopener noreferrer"
        style={{ ...styles.small, color: 'rgba(0,0,0,.5)', textDecoration: 'underline' }}
      >
        Privacy Policy
      </a>
    </div>
  );
}

export default PaymentSuccess;