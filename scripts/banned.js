"use strict";

require('./loadEnv').loadEnv();

const { Client } = require('pg');

const [, , command, ...args] = process.argv;

if (!command) {
  console.log('Usage: node scripts/banned.js <list|add|remove> [...]');
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required to manage the banned list.');
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

class UsageError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = exitCode;
  }
}

async function listBanned() {
  const { rows } = await client.query(
    `
      SELECT
        id,
        document_type,
        document_number,
        NULLIF(issuing_country, '') AS issuing_country,
        first_name,
        last_name,
        notes,
        created_at
      FROM banned_customers
      ORDER BY created_at DESC
    `
  );

  if (!rows.length) {
    console.log('No banned customers found.');
    return;
  }

  rows.forEach((row) => {
    const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown';
    console.log(`${row.id} :: ${row.document_type}/${row.document_number} (${row.issuing_country || 'N/A'}) - ${fullName} - ${row.notes || 'No note'}`);
  });
}

async function addBanned() {
  const [documentType, documentNumber, issuingCountry = '', ...noteParts] = args;

  if (!documentType || !documentNumber) {
    throw new UsageError('Usage: node scripts/banned.js add <documentType> <documentNumber> [issuingCountry] [note]');
  }

  const note = noteParts.join(' ') || null;

  await client.query(
    `
      INSERT INTO banned_customers (
        document_type,
        document_number,
        issuing_country,
        notes
      )
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (document_type, document_number, issuing_country)
      DO UPDATE
        SET notes = COALESCE(EXCLUDED.notes, banned_customers.notes),
            updated_at = NOW()
    `,
    [documentType, documentNumber, issuingCountry || '', note]
  );

  console.log('Banned record saved.');
}

async function removeBanned() {
  const [id] = args;
  if (!id) {
    throw new UsageError('Usage: node scripts/banned.js remove <id>');
  }

  const { rowCount } = await client.query(`DELETE FROM banned_customers WHERE id = $1`, [id]);
  if (rowCount) {
    console.log('Removed banned record.');
  } else {
    console.log('No record found for that id.');
  }
}

async function main() {
  await client.connect();
  let exitCode = 0;
  try {
    switch (command) {
      case 'list':
        await listBanned();
        break;
      case 'add':
        await addBanned();
        break;
      case 'remove':
        await removeBanned();
        break;
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      exitCode = error.exitCode;
    } else {
      console.error('Error:', error.message);
      exitCode = 1;
    }
  } finally {
    await client.end();
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});

