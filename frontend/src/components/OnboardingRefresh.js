import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { styles } from '../styles/shared';

function OnboardingRefresh() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const sellerId = searchParams.get('sellerId');
  const email = searchParams.get('email');

  useEffect(() => {
    const refreshOnboarding = async () => {
      try {
        // Call the onboard endpoint again to get a fresh link
        const response = await fetch('/api/sellers/onboard', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.REACT_APP_API_KEY}`
          },
          body: JSON.stringify({
            sellerId: sellerId,
            email: email,
          })
        });

        const data = await response.json();
        
        if (data.accountLink) {
          // Redirect to the new Stripe onboarding URL
          window.location.href = data.accountLink;
        } else {
          setError('Failed to get new onboarding link');
        }
      } catch (err) {
        setError(err.message);
      }
    };

    if (sellerId) {
      refreshOnboarding();
    } else {
      setError('No seller ID provided');
    }
  }, [sellerId]);

  return (
    <div style={styles.card}>
      <h1 style={styles.title}>Refreshing Onboarding...</h1>
      {error ? (
        <div>
          <p style={styles.error}>{error}</p>
          <button 
            onClick={() => navigate('/')}
            style={styles.button}
          >
            Return Home
          </button>
        </div>
      ) : (
        <p style={styles.description}>
          Please wait while we refresh your onboarding process...
        </p>
      )}
    </div>
  );
}

export default OnboardingRefresh;