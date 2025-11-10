import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
    const sql = neon(process.env.DATABASE_URL);

    // Handle CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method === 'POST') {
        try {
            const { timing_data, user_agent, session_id } = req.body;

            // Create table if it doesn't exist
            await sql`
                CREATE TABLE IF NOT EXISTS scanner_logs (
                    id SERIAL PRIMARY KEY,
                    session_id TEXT,
                    spec_load_ms INTEGER,
                    parser_create_ms INTEGER,
                    parse_ms INTEGER,
                    age_calc_ms INTEGER,
                    db_save_ms INTEGER,
                    total_ms INTEGER,
                    user_agent TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `;

            // Insert timing data
            await sql`
                INSERT INTO scanner_logs (
                    session_id,
                    spec_load_ms,
                    parser_create_ms,
                    parse_ms,
                    age_calc_ms,
                    db_save_ms,
                    total_ms,
                    user_agent
                ) VALUES (
                    ${session_id},
                    ${timing_data.spec_load},
                    ${timing_data.parser_create},
                    ${timing_data.parse},
                    ${timing_data.age_calc},
                    ${timing_data.db_save},
                    ${timing_data.total},
                    ${user_agent}
                )
            `;

            res.status(200).json({ success: true });
        } catch (error) {
            console.error('Log storage error:', error);
            res.status(500).json({ error: error.message });
        }
    } else if (req.method === 'GET') {
        try {
            // Get recent logs
            const logs = await sql`
                SELECT * FROM scanner_logs
                ORDER BY created_at DESC
                LIMIT 20
            `;

            res.status(200).json({ logs });
        } catch (error) {
            console.error('Log retrieval error:', error);
            res.status(500).json({ error: error.message });
        }
    } else {
        res.status(405).json({ error: 'Method not allowed' });
    }
}
