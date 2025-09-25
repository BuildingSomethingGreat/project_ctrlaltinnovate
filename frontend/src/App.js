import React from 'react';
import { Routes, Route } from 'react-router-dom';
import ProductForm from './components/ProductForm';
import PaymentSuccess from './components/PaymentSuccess';
import OnboardingRefresh from './components/OnboardingRefresh.js';

function App() {
  return (
    <div style={{
      background: '#f7fafc',
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px'
    }}>
      <Routes>
        <Route path="/" element={<ProductForm />} />
        <Route path="/success" element={<PaymentSuccess />} />
        <Route path="/refresh" element={<OnboardingRefresh />} />
      </Routes>
    </div>
  );
}

export default App;