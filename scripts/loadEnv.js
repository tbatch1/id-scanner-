"use strict";

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

function sanitizeVercelCliValue(value) {
  if (typeof value !== 'string') return value;
  // Remove literal "\n"/"\r\n" sequences (Vercel CLI) and actual newlines.
  // Keep it conservative: trim only and strip trailing escape sequences.
  return value
    .replace(/(\\r\\n|\\n|\\r)+$/g, '')
    .replace(/[\r\n]+$/g, '')
    .trim()
    .replace(/^"|"$/g, '');
}

function loadEnv() {
  const cwd = process.cwd();

  const primaryPath = process.env.DOTENV_PATH || path.resolve(cwd, '.env');
  dotenv.config({ path: primaryPath });

  // Fallback: load Vercel-pulled production env locally without overriding host/.env values.
  try {
    const prodPath = path.resolve(cwd, '.env.production.local');
    if (!process.env.DOTENV_PATH && fs.existsSync(prodPath)) {
      dotenv.config({ path: prodPath, override: false });
    }
  } catch {
    // ignore
  }

  try {
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value !== 'string') continue;
      const next = sanitizeVercelCliValue(value);
      if (next !== value) process.env[key] = next;
    }
  } catch {
    // ignore
  }
}

module.exports = { loadEnv };

