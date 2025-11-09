module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/backend/tests/**/*.test.js'],
  collectCoverageFrom: ['backend/src/**/*.js'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    'backend/src/server.js',
    'backend/src/app.js'
  ]
};
