'use strict';

/**
 * Universal ESM-safe loader for @whiskeysockets/baileys (v7 is pure ESM).
 * Works reliably on Node 18, 20, 22, 24 and Vercel Serverless Functions
 * without ever throwing ERR_REQUIRE_ESM at module load time.
 */
let _baileysPromise = null;
let _baileysCache = null;

async function getBaileys() {
    if (_baileysCache) return _baileysCache;
    if (!_baileysPromise) {
        _baileysPromise = (async () => {
            try {
                const mod = await import('@whiskeysockets/baileys');
                _baileysCache = mod;
                return mod;
            } catch (esmErr) {
                try {
                    const mod = require('@whiskeysockets/baileys');
                    _baileysCache = mod;
                    return mod;
                } catch (_) {
                    throw esmErr;
                }
            }
        })();
    }
    return _baileysPromise;
}

module.exports = { getBaileys };
