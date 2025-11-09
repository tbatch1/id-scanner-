// Vercel serverless function wrapper for Express app
const { app } = require('../backend/src/app');

// Handle the request-response cycle in Vercel's serverless environment
module.exports = async (req, res) => {
  // Set up error handling for async operations
  try {
    return app(req, res);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
