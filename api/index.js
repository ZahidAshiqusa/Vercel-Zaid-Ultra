'use strict';

/**
 * Lightweight, crash-proof Vercel Serverless API Handler
 * Serves pairing, live status polling, Supabase Active Bots stats, and cron-job.org keep-alive
 * without loading heavy dashboard modules or hitting ERR_REQUIRE_ESM on cold start.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

// CORS + no-store defaults
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

let _sessionManager = null;
let _sessionManagerErr = null;
function getSessionManager() {
    if (_sessionManager) return _sessionManager;
    try {
        _sessionManager = require('../lib/sessionManager');
        _sessionManagerErr = null;
        return _sessionManager;
    } catch (err) {
        _sessionManagerErr = err;
        console.error('[api] Failed to load sessionManager:', err.stack || err.message);
        return null;
    }
}

let _authState = null;
function getAuthStateModule() {
    if (_authState) return _authState;
    try {
        _authState = require('../lib/authState');
        return _authState;
    } catch (err) {
        console.error('[api] Failed to load authState:', err.message);
        return null;
    }
}

let _bootStarted = false;
function triggerBootRehydration() {
    if (_bootStarted) return;
    _bootStarted = true;
    const sm = getSessionManager();
    if (sm && typeof sm.ensureSessionsAlive === 'function') {
        sm.ensureSessionsAlive().catch((err) => {
            console.warn('[api] Cold-start rehydration notice:', err.message);
        });
    }
}

// Health check
app.get(['/health', '/api/health'], (req, res) => {
    const auth = getAuthStateModule();
    const sm = getSessionManager();
    const onlineBots = sm?.getConnectedSessions ? sm.getConnectedSessions().length : 0;
    const creds = auth?.getSupabaseCredentials ? auth.getSupabaseCredentials() : { isConfigured: false, mode: 'none' };

    res.status(200).json({
        ok: true,
        status: 'ok',
        runtime: process.env.VERCEL ? 'vercel' : 'node',
        nodeVersion: process.version,
        onlineBots,
        supabaseConfigured: Boolean(creds.isConfigured),
        supabaseMode: creds.mode,
        timestamp: new Date().toISOString()
    });
});

// Dedicated cron-job.org 5-minute keep-alive endpoint
app.get(['/api/cron', '/api/ping', '/cron', '/ping'], async (req, res) => {
    try {
        const sm = getSessionManager();
        if (!sm || typeof sm.ensureSessionsAlive !== 'function') {
            return res.status(200).json({
                ok: true,
                status: 'standby',
                runtime: process.env.VERCEL ? 'vercel' : 'node',
                onlineCount: 0,
                totalSavedCount: 0,
                warning: _sessionManagerErr ? _sessionManagerErr.message : 'Session manager unavailable',
                timestamp: new Date().toISOString()
            });
        }
        const stats = await sm.ensureSessionsAlive();
        return res.status(200).json({
            ok: true,
            status: 'alive',
            runtime: process.env.VERCEL ? 'vercel' : 'node',
            ...stats
        });
    } catch (err) {
        console.error('[api/cron] Error:', err.message);
        return res.status(200).json({
            ok: false,
            status: 'degraded',
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Active Bots counter endpoint (Supabase + Live Sockets)
app.get('/api/bots/stats', async (req, res) => {
    triggerBootRehydration();
    try {
        const sm = getSessionManager();
        if (sm && typeof sm.getActiveStats === 'function') {
            const stats = await sm.getActiveStats();
            return res.status(200).json({ success: true, ...stats });
        }

        // Ultra-fast Supabase-only fallback
        const auth = getAuthStateModule();
        const cloudIds = auth?.listSupabaseSessionIds ? await auth.listSupabaseSessionIds().catch(() => []) : [];
        const bots = cloudIds.map((id) => {
            const clean = String(id).replace(/\D/g, '');
            const masked = clean.length > 6 ? `+${clean.slice(0, 4)} •••• ${clean.slice(-3)}` : `+${clean}`;
            return { maskedNumber: masked, online: false, status: 'active' };
        });

        return res.status(200).json({
            success: true,
            onlineCount: 0,
            totalActiveCount: bots.length,
            supabaseConfigured: Boolean(auth?.getSupabaseCredentials?.().isConfigured),
            bots
        });
    } catch (err) {
        console.error('[api/bots/stats] Error:', err.message);
        return res.status(200).json({
            success: true,
            onlineCount: 0,
            totalActiveCount: 0,
            supabaseConfigured: false,
            bots: []
        });
    }
});

// Pairing code generation (auto-replaces any existing session for the number)
const handlePair = async (req, res) => {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'WhatsApp phone number is required (e.g. 923001234567).' });
    }

    let cleanNumber = String(phoneNumber).replace(/\D/g, '');
    if (cleanNumber.startsWith('00')) cleanNumber = cleanNumber.substring(2);
    if (cleanNumber.startsWith('0') && cleanNumber.length === 11) {
        cleanNumber = '92' + cleanNumber.substring(1);
    }
    if (!cleanNumber || cleanNumber.length < 7) {
        return res.status(400).json({ success: false, error: 'Invalid phone number format. Include country code (e.g. 923001234567).' });
    }

    const sm = getSessionManager();
    if (!sm || typeof sm.generatePairingCode !== 'function') {
        return res.status(503).json({
            success: false,
            error: _sessionManagerErr ? `Engine unavailable: ${_sessionManagerErr.message}` : 'Pairing engine unavailable.'
        });
    }

    try {
        const code = await sm.generatePairingCode(cleanNumber);
        return res.status(200).json({ success: true, code, cleanNumber });
    } catch (err) {
        console.error(`[api/pair] Pairing failed for +${cleanNumber}:`, err.message);
        return res.status(500).json({
            success: false,
            error: err.message || 'Failed to generate pairing code. Please try again.'
        });
    }
};

app.post(['/api/pair', '/api/session/pair'], handlePair);

// Live pairing status polling
app.get('/api/pair/status/:number', (req, res) => {
    try {
        const sm = getSessionManager();
        if (!sm || typeof sm.getSessionStatus !== 'function') {
            return res.status(200).json({ success: true, connected: false, pending: false, reconnecting: false });
        }
        const status = sm.getSessionStatus(req.params.number);
        return res.status(200).json({ success: true, ...status });
    } catch (err) {
        return res.status(200).json({ success: false, connected: false, error: err.message });
    }
});

// Fallback for direct hits to index
app.get(['/', '/index.html'], (req, res) => {
    const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
        return res.sendFile(htmlPath);
    }
    return res.status(200).send('WhatsApp Bot Pairing Service Ready');
});

// Global error boundary (never crashes with opaque 500 FUNCTION_INVOCATION_FAILED)
app.use((err, req, res, _next) => {
    console.error('[api] Unhandled error:', err?.stack || err);
    res.status(500).json({
        success: false,
        error: err?.message || 'Internal server error'
    });
});

module.exports = app;
