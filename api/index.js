// Vercel serverless function wrapper for Express app
// NOTE: Require the Express app lazily so bootstrap errors (missing deps, etc.)
// return a JSON error instead of crashing the Vercel function invocation.

// Handle the request-response cycle in Vercel's serverless environment
module.exports = async (req, res) => {
  try {
    let app;
    try {
      ({ app } = require('../backend/src/app'));
    } catch (bootstrapError) {
      console.error('API bootstrap error:', bootstrapError);
      return res.status(500).json({
        error: 'BOOTSTRAP_ERROR',
        message: 'API failed to start. See server logs for details.',
        technical: bootstrapError?.message || String(bootstrapError)
      });
    }

    return app(req, res);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
      technical: error?.message || String(error)
    });
  }
};
