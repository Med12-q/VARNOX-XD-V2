/**
 * VARNOX XD V2 — Health Check
 * Vercel Serverless Function: /api/health
 */

module.exports = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.json({
        status: 'online',
        bot: 'VARNOX XD V2',
        version: '2.0.0',
        platform: 'Vercel',
        timestamp: new Date().toISOString()
    });
};
