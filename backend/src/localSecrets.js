const fs = require('fs');
const path = require('path');

function loadJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function setEnvIfMissing(key, value) {
  if (!key) return;
  if (process.env[key] !== undefined && String(process.env[key]).length) return;
  if (value === undefined || value === null) return;
  process.env[key] = String(value);
}

function loadLocalSecrets() {
  const rootDir = path.resolve(__dirname, '..', '..');
  const secretsPath = path.join(rootDir, '.secrets.local.json');
  const secrets = loadJsonFile(secretsPath);
  if (!secrets) return { loaded: false, path: secretsPath };

  for (const [key, value] of Object.entries(secrets)) {
    setEnvIfMissing(key, value);
  }

  return { loaded: true, path: secretsPath, keys: Object.keys(secrets) };
}

module.exports = {
  loadLocalSecrets
};

