const express = require('express');
const router = express.Router();
const os = require('os');
const { sql } = require('../db');
const { irisAuth } = require('../middleware/irisAuth');
const { getSecurityStats } = require('../middleware/security');

// Apply strict authentication to all IRIS routes
router.use(irisAuth);

// 1. System Health Endpoint
router.get('/system-health', async (req, res) => {
    try {
        const uptime = os.uptime();
        const loadAvg = os.loadavg();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();

        // Calculate dummy 'latency' by checking DB connection time
        const start = Date.now();
        await sql`SELECT 1`;
        const latency = Date.now() - start;

        res.json({
            status: 'healthy',
            uptime_seconds: uptime,
            cpu_load: loadAvg,
            memory: {
                total_bytes: totalMem,
                free_bytes: freeMem,
                used_percent: ((totalMem - freeMem) / totalMem * 100).toFixed(2)
            },
            db_latency_ms: latency,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[IRIS] System health check failed:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// 2. AI Agents Status Endpoint
router.get('/ai-agents', async (req, res) => {
    try {
        // Check Gemini API Availability
        const geminiKey = process.env.GEMINI_API_KEY;
        const geminiStatus = geminiKey ? 'Active' : 'Error (Missing Key)';

        // Check "Mock" Agent Queue via unpublished products
        const pendingProducts = await sql`
            SELECT COUNT(*) as count FROM seller_products WHERE published = 0
        `;

        const pendingCount = parseInt(pendingProducts[0]?.count || 0);
        let agentState = 'Idle';
        if (pendingCount > 0) agentState = 'Active';
        if (!geminiKey) agentState = 'Error';

        res.json({
            agents: [
                {
                    name: 'Safety Agent',
                    type: 'Product Scanner',
                    status: agentState,
                    provider: 'Gemini 1.5 Flash',
                    task_queue: pendingCount,
                    last_active: new Date().toISOString() // Mock for now
                }
            ],
            global_status: agentState === 'Error' ? 'Degraded' : 'Operational'
        });
    } catch (error) {
        console.error('[IRIS] AI Agents check failed:', error);
        res.status(500).json({ error: 'Failed to fetch agent status' });
    }
});

// 3. Security Status Endpoint
router.get('/security', (req, res) => {
    try {
        // Reuse existing security stats from middleware
        const stats = getSecurityStats();

        res.json({
            blocked_ips: stats.blacklistedIPs,
            locked_accounts: stats.lockedAccounts,
            active_rate_limiters: stats.rateLimitersActive,
            recent_threats: stats.recentEvents.filter(e => e.type !== 'RATE_LIMITED').length,
            status: stats.blacklistedIPs > 10 ? 'Under Attack' : 'Secure'
        });
    } catch (error) {
        console.error('[IRIS] Security check failed:', error);
        res.status(500).json({ error: 'Failed to fetch security stats' });
    }
});

// 4. Growth Metrics (KPIs) Endpoint
router.get('/growth-metrics', async (req, res) => {
    try {
        // Total Users
        const usersResult = await sql`SELECT COUNT(*) as count FROM users`;
        const totalUsers = parseInt(usersResult[0]?.count || 0);

        // New Signups (Last 24h)
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const newUsersResult = await sql`
            SELECT COUNT(*) as count FROM users WHERE created_at > ${yesterday}
        `;
        const newUsers = parseInt(newUsersResult[0]?.count || 0);

        // Pending Contact Messages
        const messagesResult = await sql`
            SELECT COUNT(*) as count FROM contact_messages WHERE read = 0
        `;
        const pendingMessages = parseInt(messagesResult[0]?.count || 0);

        res.json({
            total_users: totalUsers,
            new_users_24h: newUsers,
            pending_messages: pendingMessages,
            growth_trend: newUsers > 0 ? 'Upward' : 'Stable'
        });
    } catch (error) {
        console.error('[IRIS] Growth metrics check failed:', error);
        res.status(500).json({ error: 'Failed to fetch growth metrics' });
    }
});

module.exports = router;
