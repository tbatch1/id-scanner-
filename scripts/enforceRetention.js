"use strict";

const { shutdown, pool } = require('../backend/src/db');
const complianceStore = require('../backend/src/complianceStore');

function parseRetentionEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function main() {
  if (!pool) {
    console.error('DATABASE_URL is not configured. Retention enforcement cannot run.');
    process.exit(1);
  }

  const verificationDays = parseRetentionEnv('RETENTION_DAYS', 365);
  const overrideDays = parseRetentionEnv('RETENTION_OVERRIDES_DAYS', verificationDays);
  const completionDays = parseRetentionEnv('RETENTION_COMPLETIONS_DAYS', verificationDays);

  let exitCode = 0;

  try {
    const results = await complianceStore.enforceRetention({
      verificationDays,
      overrideDays,
      completionDays
    });

    console.log(
      `Retention enforcement complete: ${results.verificationsDeleted} verifications, ` +
        `${results.overridesDeleted} overrides, ${results.completionsDeleted} sale completions removed.`
    );
  } catch (error) {
    console.error('Retention enforcement failed:', error.message);
    exitCode = 1;
  } finally {
    await shutdown();
    process.exit(exitCode);
  }
}

main();
