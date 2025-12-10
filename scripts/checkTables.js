"use strict";

require('dotenv').config();

const { Client } = require('pg');

async function checkTables() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL is not set.');
    }

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    await client.connect();
    console.log('Connected to database');

    try {
        const { rows } = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

        console.log('Existing tables:');
        rows.forEach(row => console.log(' -', row.table_name));

        // Also check if verifications table has required columns
        const { rows: cols } = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'verifications'
      ORDER BY ordinal_position
    `);

        console.log('\nverifications columns:');
        cols.forEach(col => console.log(' -', col.column_name, ':', col.data_type));

    } catch (error) {
        console.error('Error:', error.message);
        throw error;
    } finally {
        await client.end();
    }
}

checkTables().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
