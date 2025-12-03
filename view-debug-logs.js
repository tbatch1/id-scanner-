const https = require('https');

https.get('https://id-scanner-project-ixcqvolmj-tommys-projects-c5147bad.vercel.app/api/debug-logs', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            const logs = parsed.logs || [];

            if (logs.length === 0) {
                console.log('No debug logs found');
                return;
            }

            // Group by session
            const sessions = {};
            logs.forEach(log => {
                if (!sessions[log.session_id]) {
                    sessions[log.session_id] = [];
                }
                sessions[log.session_id].push(log);
            });

            // Get latest session
            const sessionIds = Object.keys(sessions);
            const latestSession = sessionIds[0];

            console.log('════════════════════════════════════════════════════════');
            console.log('LATEST SCANNING SESSION DEBUG LOGS');
            console.log('════════════════════════════════════════════════════════');
            console.log('Session ID:', latestSession);
            console.log('Total messages:', sessions[latestSession].length);
            console.log('User Agent:', sessions[latestSession][0].user_agent);
            console.log('════════════════════════════════════════════════════════\n');

            // Show logs in chronological order (reverse because API returns newest first)
            const sessionLogs = sessions[latestSession].reverse();

            // Display all logs exactly as they would appear on the webpage
            sessionLogs.forEach((log, index) => {
                const timestamp = new Date(log.created_at).toLocaleTimeString();
                const level = log.level.toUpperCase();
                const levelPadded = level.padEnd(5);

                console.log(`[${index + 1}/${sessionLogs.length}] [${timestamp}] [${levelPadded}] ${log.message}`);
            });

            console.log('\n════════════════════════════════════════════════════════');
            console.log('SUMMARY');
            console.log('════════════════════════════════════════════════════════');

            const levels = {};
            sessionLogs.forEach(log => {
                levels[log.level] = (levels[log.level] || 0) + 1;
            });

            Object.keys(levels).forEach(level => {
                console.log(`${level.toUpperCase()}: ${levels[level]} messages`);
            });

            // Look for specific keywords
            console.log('\n════════════════════════════════════════════════════════');
            console.log('KEY EVENTS');
            console.log('════════════════════════════════════════════════════════');

            const keywords = ['error', 'Error', 'fail', 'Fail', 'Barcode', 'detected',
                            'captured', 'parse', 'POST', 'Ready', 'Camera', 'initialized'];

            const keyEvents = sessionLogs.filter(log =>
                keywords.some(keyword => log.message.includes(keyword))
            );

            if (keyEvents.length > 0) {
                keyEvents.forEach(log => {
                    const timestamp = new Date(log.created_at).toLocaleTimeString();
                    console.log(`[${timestamp}] ${log.message}`);
                });
            } else {
                console.log('No key events found (errors, scans, etc.)');
            }

        } catch (err) {
            console.error('Parse error:', err.message);
        }
    });
}).on('error', err => {
    console.error('Request error:', err.message);
});
