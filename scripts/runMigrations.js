"use strict";

require('./loadEnv').loadEnv();

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

function loadBaseSchema() {
  const schemaPath = path.resolve(__dirname, '../backend/src/schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Base schema not found: ${schemaPath}`);
  }
  return fs.readFileSync(schemaPath, 'utf8');
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      executed_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(client) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((row) => row.filename));
}

async function recordMigration(client, filename) {
  await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [
    filename
  ]);
}

function loadMigrations() {
  const migrationsDir = path.resolve(__dirname, '../backend/migrations');
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({
      filename: file,
      filepath: path.join(migrationsDir, file),
      sql: fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    }));
}

async function runMigrations() {
  const connectionString = String(process.env.DATABASE_URL || '')
    .replace(/\\r\\n/g, '')
    .replace(/\\n/g, '')
    .replace(/\\r/g, '')
    .replace(/[\r\n]/g, '')
    .trim()
    .replace(/^"|"$/g, '');
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Export it before running migrations.');
  }

  const client = new Client({
    connectionString,
    ssl:
      process.env.NODE_ENV === 'production'
        ? {
            rejectUnauthorized: false
          }
        : false
  });

  await client.connect();
  console.log('Connected to database');

  try {
    // Ensure core tables/views exist (schema.sql is idempotent).
    const baseSchema = loadBaseSchema();
    await client.query('BEGIN');
    await client.query(baseSchema);
    await client.query('COMMIT');

    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const migrations = loadMigrations();

    if (!migrations.length) {
      console.log('No migration files found.');
      return;
    }

    for (const migration of migrations) {
      if (applied.has(migration.filename)) {
        console.log(`Skipping ${migration.filename} (already applied)`);
        continue;
      }

      console.log(`Applying ${migration.filename}...`);
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await recordMigration(client, migration.filename);
        await client.query('COMMIT');
        console.log(`Applied ${migration.filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Failed to apply ${migration.filename}: ${error.message}`);
      }
    }

    console.log('Migrations completed.');
  } finally {
    await client.end();
  }
}

runMigrations().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
