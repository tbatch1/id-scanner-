const https = require('https');

https.get('https://id-scanner-project-ixcqvolmj-tommys-projects-c5147bad.vercel.app/api/debug-logs', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            const logs = parsed.logs || [];

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
            if (sessionIds.length > 0) {
                const latestSession = sessionIds[0];
                console.log('=== Latest Session:', latestSession, '===\n');

                // Show last 50 messages
                const sessionLogs = sessions[latestSession].slice(-50);

                // Look for errors, warnings, or scan-related messages
                console.log('=== Scan Activity ===');
                sessionLogs.forEach(log => {
                    const msg = log.message;
                    if (msg.includes('error') || msg.includes('Error') ||
                        msg.includes('fail') || msg.includes('Fail') ||
                        log.level === 'error' || log.level === 'warn' ||
                        msg.includes('Barcode') || msg.includes('detected') ||
                        msg.includes('POST') || msg.includes('capture') ||
                        msg.includes('parse') || msg.includes('Ready')) {
                        console.log(`[${log.level.toUpperCase()}] ${log.message}`);
                    }
                });

                console.log('\n=== Recent Frame Quality (last 5) ===');
                sessionLogs.filter(l => l.message.includes('Frame quality')).slice(-5).forEach(log => {
                    console.log(log.message);
                });
            } else {
                console.log('No sessions found');
            }
        } catch (err) {
            console.error('Parse error:', err.message);
        }
    });
}).on('error', err => {
    console.error('Request error:', err.message);
});
