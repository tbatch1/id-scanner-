"use strict";

require('dotenv').config();

const config = require('../backend/src/config');
const lightspeed = require('../backend/src/lightspeedClient');

async function maybeRefresh() {
  if (process.argv.includes('--refresh') && typeof lightspeed.refreshAccessToken === 'function') {
    try {
      await lightspeed.refreshAccessToken(true);
      return { refreshed: true };
    } catch (error) {
      return {
        refreshed: false,
        error: error.message
      };
    }
  }

  return { refreshed: false };
}

function renderStatus(state) {
  const lines = [];
  const indent = (label, value) => lines.push(`${label.padEnd(24)}: ${value}`);

  indent('Environment', config.env);
  indent('Lightspeed mode', process.env.LIGHTSPEED_USE_MOCK === 'true' ? 'mock' : 'live');
  indent('Writes enabled', config.lightspeed.enableWrites ? 'yes' : 'no');
  indent('Account ID', config.lightspeed.accountId || 'n/a');
  indent('Client ID configured', config.lightspeed.clientId ? 'yes' : 'no');
  indent('Refresh token present', state.hasRefreshToken ? 'yes' : 'no');
  indent('OAuth status', state.status || 'unknown');
  indent(
    'Access token expires',
    state.accessTokenExpiresAt ? new Date(state.accessTokenExpiresAt).toISOString() : 'n/a'
  );
  indent('Last auth error', state.lastError || 'none');
  indent('Default outlet', config.lightspeed.defaultOutletId || 'n/a');
  indent(
    'Configured outlets',
    Object.keys(config.lightspeed.outlets || {}).length.toString()
  );

  return lines.join('\n');
}

async function main() {
  const refreshResult = await maybeRefresh();
  const state =
    typeof lightspeed.getAuthState === 'function' ? lightspeed.getAuthState() || {} : {};

  console.log('Lightspeed OAuth status\n-----------------------');
  console.log(renderStatus(state));

  if (refreshResult.refreshed) {
    console.log('\nToken refresh: success');
  } else if (refreshResult.error) {
    console.log(`\nToken refresh failed: ${refreshResult.error}`);
  } else {
    console.log('\nToken refresh: skipped (use --refresh to force)');
  }
}

main().catch((error) => {
  console.error('Unable to inspect OAuth status:', error.message);
  process.exit(1);
});
