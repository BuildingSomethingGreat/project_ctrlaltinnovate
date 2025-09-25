const admin = require('firebase-admin');

async function verifyFirebaseToken(req, res, next) {
//   const authHeader = req.headers.authorization || '';
//   const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  
//   if (!token) {
//     return res.status(401).send({ error: 'Unauthorized: no token' });
//   }

//   // Simple API key check
//   if (token === process.env.API_KEY) {
//     req.user = { id: 'default-user' };
//     return next();
//   }

//   return res.status(401).send({ error: 'Unauthorized: invalid token' });
  return next();
}

module.exports = { verifyFirebaseToken };