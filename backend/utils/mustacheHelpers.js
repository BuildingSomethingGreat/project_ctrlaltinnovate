// utils/mustacheHelpers.js
function formatPrice(cents, currency = 'usd') {
    if (typeof cents !== 'number') return '';
    const amount = (cents / 100).toFixed(2);
    return amount;
  }
  
  module.exports = { formatPrice };
  