const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');

const CONNECT_URL = 'https://secure.retail.lightspeed.app/connect';
const TOKEN_PATH = '/api/1.0/token';

const DEFAULT_SCOPES = 'sales:read sales:write customers:read customers:write webhooks';

const oauthCache = {
  tokens: null,
  loadedAtMs: 0
};

function getScopes() {
  const raw = String(process.env.LIGHTSPEED_OAUTH_SCOPES || DEFAULT_SCOPES);
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

function nowMs() {
  return Date.now();
}

function epochSecondsToMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num * 1000);
}

function mustHave(value, name) {
  const v = String(value || '').trim();
  if (!v) {
    const err = new Error(`Missing ${name}`);
    err.code = 'MISSING_CONFIG';
    throw err;
  }
  return v;
}

function hasOAuthConfig() {
  const clientId = String(config.lightspeed.clientId || '').trim();
  const clientSecret = String(config.lightspeed.clientSecret || '').trim();
  const redirectUri = String(config.lightspeed.redirectUri || '').trim();
  return Boolean(clientId && clientSecret && redirectUri);
}

function tokenUrlForDomainPrefix(domainPrefix) {
  const dp = String(domainPrefix || '').trim();
  if (!dp) return null;
  return `https://${dp}.retail.lightspeed.app${TOKEN_PATH}`;
}

async function ensureOAuthTable() {
  if (!db.pool) return false;

  await db.query(
    `
      CREATE TABLE IF NOT EXISTS lightspeed_oauth_tokens (
        domain_prefix TEXT PRIMARY KEY,
        access_token TEXT,
        refresh_token TEXT,
        scope TEXT,
        expires_at_ms BIGINT,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `
  );
  return true;
}

async function loadTokensFromDb(domainPrefix = null) {
  if (!db.pool) return null;
  await ensureOAuthTable();

  const dp = String(domainPrefix || '').trim();
  const { rows } = dp
    ? await db.query('SELECT * FROM lightspeed_oauth_tokens WHERE domain_prefix = $1 LIMIT 1', [dp])
    : await db.query('SELECT * FROM lightspeed_oauth_tokens ORDER BY updated_at DESC LIMIT 1', []);

  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    domainPrefix: row.domain_prefix,
    accessToken: row.access_token || null,
    refreshToken: row.refresh_token || null,
    scope: row.scope || null,
    expiresAtMs: row.expires_at_ms ? Number(row.expires_at_ms) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

function getLocalTokenPath() {
  const rootDir = path.resolve(__dirname, '..', '..');
  return path.join(rootDir, '.lightspeed_oauth_tokens.local.json');
}

function loadTokensFromFile(domainPrefix = null) {
  try {
    const tokenPath = getLocalTokenPath();
    if (!fs.existsSync(tokenPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const items = Array.isArray(parsed.tokens) ? parsed.tokens : [];

    const dp = String(domainPrefix || '').trim();
    const row = dp ? items.find((t) => String(t.domainPrefix || '').trim() === dp) : items[0] || null;
    if (!row) return null;

    return {
      domainPrefix: row.domainPrefix || null,
      accessToken: row.accessToken || null,
      refreshToken: row.refreshToken || null,
      scope: row.scope || null,
      expiresAtMs: row.expiresAtMs ? Number(row.expiresAtMs) : null,
      updatedAt: row.updatedAt || null
    };
  } catch {
    return null;
  }
}

function saveTokensToFile({ domainPrefix, accessToken, refreshToken, scope, expiresAtMs }) {
  const tokenPath = getLocalTokenPath();
  const dp = mustHave(domainPrefix, 'domain_prefix');

  const nextRow = {
    domainPrefix: dp,
    accessToken: accessToken || null,
    refreshToken: refreshToken || null,
    scope: scope || null,
    expiresAtMs: expiresAtMs || null,
    updatedAt: new Date().toISOString()
  };

  let payload = { tokens: [] };
  try {
    if (fs.existsSync(tokenPath)) {
      const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      if (parsed && typeof parsed === 'object') payload = parsed;
    }
  } catch {
    payload = { tokens: [] };
  }

  const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
  const merged = new Map(tokens.map((t) => [String(t.domainPrefix || '').trim(), t]));
  merged.set(String(dp).trim(), nextRow);
  payload.tokens = Array.from(merged.values());

  fs.writeFileSync(tokenPath, JSON.stringify(payload, null, 2), 'utf8');
  return true;
}

async function saveTokensToDb({
  domainPrefix,
  accessToken,
  refreshToken,
  scope,
  expiresAtMs
}) {
  if (!db.pool) {
    // Local-dev fallback: allow OAuth without a database by persisting tokens to a local file.
    if (String(config.env || '').toLowerCase() !== 'production') {
      saveTokensToFile({ domainPrefix, accessToken, refreshToken, scope, expiresAtMs });
      return;
    }
    const err = new Error('DATABASE_URL is not configured; cannot persist OAuth tokens.');
    err.code = 'DB_DISABLED';
    throw err;
  }
  await ensureOAuthTable();

  const dp = mustHave(domainPrefix, 'domain_prefix');
  await db.query(
    `
      INSERT INTO lightspeed_oauth_tokens (domain_prefix, access_token, refresh_token, scope, expires_at_ms)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (domain_prefix)
      DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        scope = EXCLUDED.scope,
        expires_at_ms = EXCLUDED.expires_at_ms,
        updated_at = NOW()
    `,
    [dp, accessToken || null, refreshToken || null, scope || null, expiresAtMs || null]
  );
}

async function loadTokensCached(domainPrefix = null) {
  const cacheTtlMs = 10_000;
  if (oauthCache.tokens && nowMs() - oauthCache.loadedAtMs < cacheTtlMs) {
    if (!domainPrefix || oauthCache.tokens.domainPrefix === domainPrefix) return oauthCache.tokens;
  }

  const fromDb = await loadTokensFromDb(domainPrefix);
  const fromFile = !fromDb ? loadTokensFromFile(domainPrefix) : null;
  const envRefreshToken = String(config.lightspeed.refreshToken || '').trim();
  const envDomain = String(config.lightspeed.domainPrefix || config.lightspeed.accountId || '').trim();

  const tokens =
    fromDb ||
    fromFile ||
    (envRefreshToken
      ? {
          domainPrefix: envDomain || null,
          accessToken: null,
          refreshToken: envRefreshToken,
          scope: null,
          expiresAtMs: null,
          updatedAt: null
        }
      : null);

  oauthCache.tokens = tokens;
  oauthCache.loadedAtMs = nowMs();
  return tokens;
}

async function getAuthState() {
  const hasClientId = Boolean(String(config.lightspeed.clientId || '').trim());
  const hasClientSecret = Boolean(String(config.lightspeed.clientSecret || '').trim());
  const hasRedirectUri = Boolean(String(config.lightspeed.redirectUri || '').trim());
  const hasConfig = hasClientId && hasClientSecret && hasRedirectUri;

  if (!hasConfig) {
    return {
      status: 'needs_configuration',
      hasRefreshToken: Boolean(String(config.lightspeed.refreshToken || '').trim()),
      accessTokenExpiresAt: null,
      lastError: null
    };
  }

  const tokens = await loadTokensCached();
  const refreshToken = String(tokens?.refreshToken || '').trim();
  const hasRefreshToken = Boolean(refreshToken);
  const expiresAtMs = Number(tokens?.expiresAtMs || 0);
  const accessTokenExpiresAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;

  if (!hasRefreshToken) {
    return {
      status: 'needs_login',
      hasRefreshToken: false,
      accessTokenExpiresAt,
      lastError: null
    };
  }

  if (!tokens?.accessToken || !expiresAtMs) {
    return {
      status: 'expiring',
      hasRefreshToken: true,
      accessTokenExpiresAt,
      lastError: null
    };
  }

  const msLeft = expiresAtMs - nowMs();
  const expiringSoon = msLeft <= 30 * 60_000;
  return {
    status: expiringSoon ? 'expiring' : 'ready',
    hasRefreshToken: true,
    accessTokenExpiresAt,
    lastError: null
  };
}

function buildConnectUrl({ redirectAfter = null } = {}) {
  const clientId = mustHave(config.lightspeed.clientId, 'LIGHTSPEED_CLIENT_ID');
  const redirectUri = mustHave(config.lightspeed.redirectUri, 'LIGHTSPEED_REDIRECT_URI');
  const scope = getScopes();
  const state = crypto.randomBytes(18).toString('hex');
  const url = new URL(CONNECT_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scope);

  return { url: url.toString(), state, scope, redirectAfter: redirectAfter || null };
}

function buildSetCookie(name, value, { maxAgeSeconds = 600, path = '/api/auth', httpOnly = true } = {}) {
  const encoded = encodeURIComponent(String(value || ''));
  const pieces = [`${name}=${encoded}`, `Path=${path}`, `Max-Age=${maxAgeSeconds}`, 'SameSite=Lax'];
  if (httpOnly) pieces.push('HttpOnly');
  // Vercel is always HTTPS; keep secure cookies.
  pieces.push('Secure');
  return pieces.join('; ');
}

function parseCookieHeader(cookieHeader) {
  const raw = String(cookieHeader || '');
  if (!raw) return {};
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch (e) {
      out[key] = val;
    }
  });
  return out;
}

async function exchangeAuthorizationCode({ code, domainPrefix }) {
  const clientId = mustHave(config.lightspeed.clientId, 'LIGHTSPEED_CLIENT_ID');
  const clientSecret = mustHave(config.lightspeed.clientSecret, 'LIGHTSPEED_CLIENT_SECRET');
  const redirectUri = mustHave(config.lightspeed.redirectUri, 'LIGHTSPEED_REDIRECT_URI');

  const dp = mustHave(domainPrefix, 'domain_prefix');
  const tokenUrl = tokenUrlForDomainPrefix(dp);
  if (!tokenUrl) {
    throw new Error('Missing domain_prefix for token exchange.');
  }

  const form = new URLSearchParams();
  form.set('code', mustHave(code, 'code'));
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', redirectUri);

  const response = await axios.post(tokenUrl, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10_000
  });

  const payload = response?.data || {};
  const expiresAtMs = epochSecondsToMs(payload.expires) || null;
  const tokens = {
    domainPrefix: payload.domain_prefix || dp,
    accessToken: payload.access_token || null,
    refreshToken: payload.refresh_token || null,
    scope: payload.scope || null,
    expiresAtMs
  };

  await saveTokensToDb(tokens);
  oauthCache.tokens = { ...tokens, updatedAt: new Date().toISOString() };
  oauthCache.loadedAtMs = nowMs();

  return tokens;
}

async function refreshAccessToken(force = false) {
  const clientId = mustHave(config.lightspeed.clientId, 'LIGHTSPEED_CLIENT_ID');
  const clientSecret = mustHave(config.lightspeed.clientSecret, 'LIGHTSPEED_CLIENT_SECRET');

  const current = await loadTokensCached();
  if (!current) {
    const err = new Error('No OAuth tokens found. Run OAuth login first.');
    err.code = 'NEEDS_LOGIN';
    throw err;
  }

  const dp = String(current.domainPrefix || '').trim();
  const tokenUrl = tokenUrlForDomainPrefix(dp);
  if (!tokenUrl) {
    const err = new Error('Missing domain_prefix; cannot refresh access token.');
    err.code = 'MISSING_DOMAIN_PREFIX';
    throw err;
  }

  const refreshToken = String(current.refreshToken || '').trim();
  if (!refreshToken) {
    const err = new Error('Missing refresh token; run OAuth login again.');
    err.code = 'MISSING_REFRESH_TOKEN';
    throw err;
  }

  const expiresAtMs = Number(current.expiresAtMs || 0);
  const isExpired = expiresAtMs && expiresAtMs <= nowMs() + 60_000;
  if (!force && expiresAtMs && !isExpired && current.accessToken) {
    return current;
  }

  const form = new URLSearchParams();
  form.set('refresh_token', refreshToken);
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  form.set('grant_type', 'refresh_token');

  const response = await axios.post(tokenUrl, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10_000
  });

  const payload = response?.data || {};
  const nextExpiresAtMs = epochSecondsToMs(payload.expires) || null;
  const tokens = {
    domainPrefix: payload.domain_prefix || dp,
    accessToken: payload.access_token || null,
    refreshToken: payload.refresh_token || null,
    scope: payload.scope || null,
    expiresAtMs: nextExpiresAtMs
  };

  await saveTokensToDb(tokens);
  oauthCache.tokens = { ...tokens, updatedAt: new Date().toISOString() };
  oauthCache.loadedAtMs = nowMs();
  return oauthCache.tokens;
}

async function getAccessToken() {
  // If OAuth isn't configured, return null so callers can fall back to personal tokens.
  if (!hasOAuthConfig()) return null;

  const current = await loadTokensCached();
  if (!current) return null;
  if (!current.accessToken || !current.expiresAtMs) {
    try {
      const refreshed = await refreshAccessToken(true);
      return refreshed?.accessToken || null;
    } catch (e) {
      logger.warn({ event: 'oauth_access_token_missing', error: e.message }, 'OAuth access token missing');
      return null;
    }
  }

  const needsRefresh = Number(current.expiresAtMs || 0) <= nowMs() + 2 * 60_000;
  if (needsRefresh) {
    try {
      const refreshed = await refreshAccessToken(true);
      return refreshed?.accessToken || null;
    } catch (e) {
      logger.warn({ event: 'oauth_refresh_failed', error: e.message }, 'OAuth refresh failed');
      return current.accessToken;
    }
  }

  return current.accessToken;
}

module.exports = {
  buildConnectUrl,
  buildSetCookie,
  parseCookieHeader,
  exchangeAuthorizationCode,
  refreshAccessToken,
  getAccessToken,
  getAuthState
};
