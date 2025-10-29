const { app } = require('../backend/src/app');

module.exports = (req, res) => {
  app(req, res);
};
