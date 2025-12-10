"use strict";

require('dotenv').config();

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runSchema() {
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
        const schemaPath = path.resolve(__dirname, '../backend/src/schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');

        console.log('Running schema.sql...');
        await client.query(schemaSql);
        console.log('Schema created successfully!');
    } catch (error) {
        console.error('Error:', error.message);
        throw error;
    } finally {
        await client.end();
    }
}

runSchema().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
