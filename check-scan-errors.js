const https = require('https');

// Get logs for scan-sessions endpoint
https.get('https://id-scanner-project.vercel.app/api/debug-logs', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            const logs = parsed.logs || [];

            console.log('=== Looking for Database Save Errors ===\n');

            // Find all error messages related to database saves
            const errors = logs.filter(l =>
                l.message.includes('Database save failed') ||
                l.message.includes('Database error') ||
                l.message.includes('Status: 500') ||
                l.message.includes('INTERNAL_ERROR')
            );

            if (errors.length > 0) {
                console.log(`Found ${errors.length} database error messages:\n`);
                errors.slice(-10).forEach(log => {
                    console.log(`[${log.level.toUpperCase()}] ${log.message}`);
                });

                // Show what data was being sent
                console.log('\n=== Payload Being Sent ===');
                const payloads = logs.filter(l => l.message.includes('Payload:'));
                if (payloads.length > 0) {
                    console.log(payloads[payloads.length - 1].message);
                }
            } else {
                console.log('No database errors found');
            }

            // Check if the deployment has the latest code
            console.log('\n=== Checking if latest deployment is being used ===');
            console.log('Looking for successful database saves...');
            const successes = logs.filter(l => l.message.includes('Saved to database: ID success'));
            if (successes.length > 0) {
                console.log(`Found ${successes.length} successful saves - OLD CODE`);
            } else {
                console.log('No old successful save patterns found');
            }

        } catch (err) {
            console.error('Parse error:', err.message);
        }
    });
}).on('error', err => {
    console.error('Request error:', err.message);
});
