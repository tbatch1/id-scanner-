const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_HTvjn0FrEZ7D@ep-holy-brook-a4hgmwaj-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require'
});

async function checkPerformance() {
  try {
    console.log('Connecting to Neon database...\n');

    // Check connection
    const connResult = await pool.query('SELECT NOW() as current_time');
    console.log('✓ Connected at:', connResult.rows[0].current_time);

    // Check recent verifications
    console.log('\n--- Recent Verification Activity (Last Hour) ---');
    const recentVerifications = await pool.query(`
      SELECT 
        COUNT(*) as total_verifications,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
        AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_processing_seconds
      FROM verifications 
      WHERE created_at > NOW() - INTERVAL '1 hour'
    `);
    console.log(recentVerifications.rows[0]);

    // Check table sizes
    console.log('\n--- Database Table Statistics ---');
    const tableStats = await pool.query(`
      SELECT 
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
        n_live_tup as row_count
      FROM pg_stat_user_tables 
      WHERE tablename IN ('verifications', 'sales_completions', 'banned_customers')
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `);
    console.table(tableStats.rows);

    // Check for slow queries
    console.log('\n--- Recent Query Performance ---');
    const slowQueries = await pool.query(`
      SELECT 
        query_start,
        NOW() - query_start as duration,
        state,
        LEFT(query, 80) as query_preview
      FROM pg_stat_activity 
      WHERE datname = 'neondb' 
        AND state != 'idle'
        AND query NOT LIKE '%pg_stat_activity%'
      ORDER BY query_start DESC
      LIMIT 5
    `);
    console.table(slowQueries.rows);

    // Check indexes
    console.log('\n--- Index Usage ---');
    const indexStats = await pool.query(`
      SELECT 
        schemaname,
        tablename,
        indexname,
        idx_scan as times_used,
        pg_size_pretty(pg_relation_size(indexrelid)) as index_size
      FROM pg_stat_user_indexes 
      WHERE schemaname = 'public'
      ORDER BY idx_scan DESC
      LIMIT 10
    `);
    console.table(indexStats.rows);

    await pool.end();
    console.log('\n✓ Check complete');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkPerformance();
