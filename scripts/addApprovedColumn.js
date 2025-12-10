"use strict";

const { Client } = require('pg');

async function addApprovedColumn() {
    const connectionString = process.env.DATABASE_URL;
    const client = new Client({
        connectionString,
        ssl: { rejectUnauthorized: false }
    });

    await client.connect();
    console.log('Connected');

    try {
        // Check if approved column exists
        const { rows } = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'verifications' AND column_name = 'approved'
    `);

        if (rows.length === 0) {
            console.log('Adding approved column...');
            await client.query('ALTER TABLE verifications ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT true');
            console.log('Added approved column');
        } else {
            console.log('approved column already exists');
        }
    } finally {
        await client.end();
    }
}

addApprovedColumn().catch(e => {
    console.error(e.message);
    process.exit(1);
});
