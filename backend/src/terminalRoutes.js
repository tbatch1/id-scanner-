/**
 * Terminal Payment Routes
 * 
 * These routes handle card-present transactions via Maverick/NMI payment terminals.
 * The NMI API is used to trigger transactions on the physical terminal.
 */

const express = require('express');
const router = express.Router();
const logger = require('./logger');

// NMI API endpoint
const NMI_API_URL = 'https://secure.nmi.com/api/transact.php';

// Terminal IDs by location
const TERMINALS = {
    '290': process.env.NMI_TERMINAL_290 || '86646',
    'BUSH': process.env.NMI_TERMINAL_BUSH || '86552',
    'default': process.env.NMI_TERMINAL_290 || '86646'
};

/**
 * POST /api/terminal/sale
 * 
 * Triggers a card-present sale on the Maverick/NMI terminal.
 * 
 * Request body:
 *   - terminal_id: Terminal ID to use (optional, uses register_id to determine)
 *   - amount: Sale amount as string (e.g., "12.99")
 *   - sale_id: Lightspeed sale ID for reference
 *   - register_id: Register/location identifier to determine which terminal
 * 
 * Response:
 *   - success: true if transaction approved
 *   - pending: true if waiting for card
 *   - error: Error message if failed
 *   - transaction_id: NMI transaction ID if successful
 *   - approval_code: Approval code if successful
 */
router.post('/sale', async (req, res) => {
    const { terminal_id, amount, sale_id, register_id } = req.body;

    logger.info({
        event: 'terminal_sale_request',
        terminal_id,
        amount,
        sale_id,
        register_id
    });

    // Validate amount
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({
            success: false,
            error: 'Invalid amount'
        });
    }

    // Get NMI security key from environment
    const securityKey = process.env.NMI_SECURITY_KEY;

    if (!securityKey) {
        logger.warn({
            event: 'terminal_sale_no_key',
            message: 'NMI_SECURITY_KEY not configured'
        });

        // For now, return pending status to allow testing the UI
        // In production, this would be an error
        return res.json({
            pending: true,
            message: 'API key not configured - terminal integration pending',
            note: 'Please add NMI_SECURITY_KEY to environment variables'
        });
    }

    // Determine which terminal to use
    let deviceId = terminal_id;
    if (!deviceId) {
        // Try to map register_id to terminal
        if (register_id && TERMINALS[register_id.toUpperCase()]) {
            deviceId = TERMINALS[register_id.toUpperCase()];
        } else {
            deviceId = TERMINALS['default'];
        }
    }

    try {
        // Build form data for NMI API
        // NMI uses form-encoded data, not JSON
        const formData = new URLSearchParams();
        formData.append('security_key', securityKey);
        formData.append('type', 'sale');
        formData.append('amount', parsedAmount.toFixed(2));
        formData.append('poi_device_id', deviceId);
        formData.append('orderid', sale_id || `SALE-${Date.now()}`);
        formData.append('response_method', 'synchronous'); // Wait for result

        logger.info({
            event: 'terminal_api_call',
            deviceId,
            amount: parsedAmount.toFixed(2),
            sale_id
        });

        const response = await fetch(NMI_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData.toString()
        });

        const responseText = await response.text();

        // Parse NMI response (key=value format)
        const result = {};
        responseText.split('&').forEach(pair => {
            const [key, value] = pair.split('=');
            result[decodeURIComponent(key)] = decodeURIComponent(value || '');
        });

        logger.info({
            event: 'terminal_api_response',
            response_code: result.response,
            responsetext: result.responsetext,
            transactionid: result.transactionid
        });

        // NMI response codes:
        // 1 = Approved
        // 2 = Declined
        // 3 = Error
        if (result.response === '1') {
            return res.json({
                success: true,
                transaction_id: result.transactionid,
                approval_code: result.authcode,
                message: result.responsetext || 'APPROVED'
            });
        } else if (result.response === '2') {
            return res.json({
                success: false,
                error: result.responsetext || 'Transaction declined'
            });
        } else {
            return res.json({
                success: false,
                error: result.responsetext || 'Transaction error'
            });
        }

    } catch (error) {
        logger.error({
            event: 'terminal_api_error',
            error: error.message,
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            error: 'Terminal communication error'
        });
    }
});

/**
 * GET /api/terminal/status/:transactionId
 * 
 * Check the status of an async transaction (if using async mode)
 */
router.get('/status/:transactionId', async (req, res) => {
    // Placeholder for async status polling
    // NMI uses AsyncStatus API for this
    res.json({
        pending: true,
        message: 'Status check not implemented'
    });
});

module.exports = router;
