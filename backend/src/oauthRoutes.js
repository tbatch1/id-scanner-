const express = require('express');
const logger = require('./logger');
const oauth = require('./lightspeedOAuth');

const router = express.Router();

function sendHtml(res, status, title, bodyHtml) {
  res.status(status).type('html').send(`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f1419; color:#e7eef7; margin:0; padding:24px; }
        .card { max-width: 720px; margin: 0 auto; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 18px; }
        h1 { margin: 0 0 10px 0; font-size: 18px; }
        p { margin: 10px 0; line-height: 1.4; }
        code { background: rgba(0,0,0,0.35); padding: 2px 6px; border-radius: 6px; }
        .muted { opacity: 0.8; font-size: 13px; }
        .ok { color: #2de58c; }
        .warn { color: #ffcc66; }
        .err { color: #ff6b6b; }
        .btn { display:inline-block; margin-top: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.18); color:#e7eef7; text-decoration:none; }
      </style>
    </head>
    <body>
      <div class="card">
        ${bodyHtml}
        <p class="muted">You can close this tab after completing the flow.</p>
      </div>
    </body>
  </html>`);
}

// GET /api/auth/login
// Redirects to Lightspeed's OAuth connect URL.
router.get('/login', (req, res) => {
  try {
    const redirectAfter = String(req.query.redirect || '').trim() || null;
    const { url, state } = oauth.buildConnectUrl({ redirectAfter });

    // CSRF state cookie, validated on callback.
    // Keep it short-lived (10 minutes) to match Lightspeed auth code lifetime.
    const cookies = [
      oauth.buildSetCookie('ls_oauth_state', state, { maxAgeSeconds: 600, path: '/api/auth/callback' })
    ];
    if (redirectAfter) {
      cookies.push(
        oauth.buildSetCookie('ls_oauth_redirect', redirectAfter, {
          maxAgeSeconds: 900,
          path: '/api/auth/callback',
          httpOnly: true
        })
      );
    }
    res.setHeader('Set-Cookie', cookies);
    res.redirect(302, url);
  } catch (error) {
    logger.error({ event: 'oauth_login_failed', error: error.message }, 'OAuth login redirect failed');
    sendHtml(
      res,
      500,
      'OAuth Setup Error',
      `<h1 class="err">OAuth setup is incomplete</h1>
       <p>${error.message}</p>
       <p class="muted">Set <code>LIGHTSPEED_CLIENT_ID</code>, <code>LIGHTSPEED_CLIENT_SECRET</code>, and <code>LIGHTSPEED_REDIRECT_URI</code> in Vercel env.</p>`
    );
  }
});

// GET /api/auth/callback
// Handles redirect from Lightspeed and exchanges code for tokens.
router.get('/callback', async (req, res) => {
  const error = String(req.query.error || '').trim();
  if (error) {
    sendHtml(
      res,
      401,
      'OAuth Denied',
      `<h1 class="warn">Authorization declined</h1><p>Lightspeed returned: <code>${error}</code></p>`
    );
    return;
  }

  const code = String(req.query.code || '').trim();
  const domainPrefix = String(req.query.domain_prefix || '').trim();
  const state = String(req.query.state || '').trim();

  const cookies = oauth.parseCookieHeader(req.headers.cookie);
  const expectedState = String(cookies.ls_oauth_state || '').trim();
  const redirectAfter = String(cookies.ls_oauth_redirect || '').trim() || null;

  // Clear cookies regardless.
  res.setHeader('Set-Cookie', [
    oauth.buildSetCookie('ls_oauth_state', '', { maxAgeSeconds: 0, path: '/api/auth/callback' }),
    oauth.buildSetCookie('ls_oauth_redirect', '', { maxAgeSeconds: 0, path: '/api/auth/callback' })
  ]);

  if (!code || !domainPrefix) {
    sendHtml(
      res,
      400,
      'OAuth Callback Error',
      `<h1 class="err">Missing callback parameters</h1>
       <p>Expected <code>code</code> and <code>domain_prefix</code> in the callback URL.</p>`
    );
    return;
  }

  if (!state || !expectedState || state !== expectedState) {
    logger.warn(
      { event: 'oauth_state_mismatch', hasExpected: Boolean(expectedState), statePresent: Boolean(state) },
      'OAuth callback state mismatch'
    );
    sendHtml(
      res,
      400,
      'OAuth Callback Error',
      `<h1 class="err">State verification failed</h1>
       <p>Please retry the OAuth login flow.</p>`
    );
    return;
  }

  try {
    await oauth.exchangeAuthorizationCode({ code, domainPrefix });
    logger.info({ event: 'oauth_connected', domainPrefix }, 'Lightspeed OAuth connected');

    // If a redirect target was provided, attempt it (best-effort).
    // Note: admin pages may require headers; if so, users can just close this tab.
    if (redirectAfter) {
      sendHtml(
        res,
        200,
        'OAuth Connected',
        `<h1 class="ok">Connected</h1>
         <p>Lightspeed authorization succeeded for <code>${domainPrefix}</code>.</p>
         <a class="btn" href="${redirectAfter}">Return to dashboard</a>`
      );
      return;
    }

    sendHtml(
      res,
      200,
      'OAuth Connected',
      `<h1 class="ok">Connected</h1>
       <p>Lightspeed authorization succeeded for <code>${domainPrefix}</code>.</p>`
    );
  } catch (err) {
    logger.error({ event: 'oauth_exchange_failed', error: err.message }, 'OAuth token exchange failed');
    sendHtml(
      res,
      500,
      'OAuth Callback Error',
      `<h1 class="err">Token exchange failed</h1><p>${err.message}</p>`
    );
  }
});

// GET /api/auth/status
router.get('/status', async (req, res) => {
  try {
    const state = await oauth.getAuthState();
    res.status(200).json({ success: true, ...state });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
