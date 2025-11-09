// Quick migration script to set up database tables
require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set in .env file!');
  process.exit(1);
}

console.log('🔄 Connecting to database...');
console.log('URL:', DATABASE_URL.replace(/:[^:@]+@/, ':***@')); // Hide password

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function runMigration() {
  try {
    await client.connect();
    console.log('✅ Connected to database!\n');

    // Run base schema
    console.log('📝 Running base schema...');
    const schemaSQL = fs.readFileSync(
      path.join(__dirname, 'backend/src/schema.sql'),
      'utf8'
    );
    await client.query(schemaSQL);
    console.log('✅ Base schema created!\n');

    // Run additional migrations
    const migrationsDir = path.join(__dirname, 'backend/migrations');
    const migrations = fs.readdirSync(migrationsDir).sort();

    for (const migration of migrations) {
      console.log(`📝 Running migration: ${migration}...`);
      const sql = fs.readFileSync(
        path.join(migrationsDir, migration),
        'utf8'
      );
      await client.query(sql);
      console.log(`✅ ${migration} complete!`);
    }

    console.log('\n🎉 All migrations complete!');
    console.log('\n📊 Checking tables...');

    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log('\nTables created:');
    result.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });

    console.log('\n✅ Database is ready for production!');

  } catch (error) {
    console.error('\n❌ Migration failed!');
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
