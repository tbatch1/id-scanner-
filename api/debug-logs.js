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
            const { session_id, level, message, user_agent } = req.body;

            // Create table if it doesn't exist
            await sql`
                CREATE TABLE IF NOT EXISTS scanner_debug_logs (
                    id SERIAL PRIMARY KEY,
                    session_id TEXT,
                    level TEXT,
                    message TEXT,
                    user_agent TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `;

            // Insert debug log
            await sql`
                INSERT INTO scanner_debug_logs (
                    session_id,
                    level,
                    message,
                    user_agent
                ) VALUES (
                    ${session_id},
                    ${level || 'info'},
                    ${message},
                    ${user_agent}
                )
            `;

            res.status(200).json({ success: true });
        } catch (error) {
            console.error('Debug log storage error:', error);
            res.status(500).json({ error: error.message });
        }
    } else if (req.method === 'GET') {
        try {
            const { session_id } = req.query;

            let logs;
            if (session_id) {
                // Get logs for specific session
                logs = await sql`
                    SELECT * FROM scanner_debug_logs
                    WHERE session_id = ${session_id}
                    ORDER BY created_at ASC
                `;
            } else {
                // Get recent logs (last 100)
                logs = await sql`
                    SELECT * FROM scanner_debug_logs
                    ORDER BY created_at DESC
                    LIMIT 100
                `;
            }

            res.status(200).json({ logs });
        } catch (error) {
            console.error('Debug log retrieval error:', error);
            res.status(500).json({ error: error.message });
        }
    } else {
        res.status(405).json({ error: 'Method not allowed' });
    }
}
