'use strict';

/**
 * Multi-Bot WhatsApp Channel Auto-Follower & Random Auto-Reactor Service (.char)
 * Owner: Zaid Ashiq X Ultra V. Coder
 *
 * Built-in Official Multi-Bot Channel:
 *   https://whatsapp.com/channel/0029VbDrzIw5K3zThk4N2u0A
 *   - Every linked WhatsApp number automatically follows this channel on connect.
 *   - Every linked WhatsApp number independently reacts with a random emoji on every new channel post.
 *
 * Also supports custom `.char <channel_link> <emoji|random>` rules.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR, ROOT_DIR } = require('./storagePaths');

let sendButtons = null;
try {
    sendButtons = require('kango-wa').sendButtons;
} catch (_) {
    sendButtons = null;
}

const DEFAULT_CHANNEL_INVITE = '0029VbDrzIw5K3zThk4N2u0A';
const DEFAULT_CHANNEL_URL = `https://whatsapp.com/channel/${DEFAULT_CHANNEL_INVITE}`;
const RANDOM_CHANNEL_EMOJIS = [
    '❤️', '🔥', '😍', '👍', '✨', '🎉', '💯', '💖', '🙌',
    '⚡', '👏', '🤩', '💞', '🥰', '🚀', '🌟', '🫶', '👑'
];

const CHAR_CONFIG_PATH = path.join(DATA_DIR, 'channel_autoreact.json');
const REPO_CHAR_CONFIG_PATH = path.join(ROOT_DIR, 'data', 'channel_autoreact.json');

// Per-session deduplication set: `${sessionKey}:${channelJid}:${serverId}`
// Ensures EVERY linked WhatsApp number reacts once per post independently.
const reactedPostKeys = new Set();
const followedSessions = new Map(); // cleanNumber -> { followed, channelJid, channelName, followedAt }
let cachedDefaultChannelMeta = {
    inviteCode: DEFAULT_CHANNEL_INVITE,
    inviteUrl: DEFAULT_CHANNEL_URL,
    channelJid: null,
    channelName: 'Official Multi-Bot Channel',
};

function pickRandomChannelEmoji() {
    return RANDOM_CHANNEL_EMOJIS[Math.floor(Math.random() * RANDOM_CHANNEL_EMOJIS.length)];
}

function getSessionKey(sock) {
    const raw = sock?._sessionNumber || sock?.user?.id || 'default';
    return String(raw).split(':')[0].split('@')[0].replace(/\D/g, '') || 'default';
}

function markPostReacted(key) {
    if (!key) return false;
    if (reactedPostKeys.has(key)) return true;
    reactedPostKeys.add(key);
    if (reactedPostKeys.size > 10000) {
        const oldest = reactedPostKeys.values().next().value;
        reactedPostKeys.delete(oldest);
    }
    return false;
}

function ensureDefaultChannelRule(store) {
    if (!store || !Array.isArray(store.rules)) {
        store = { rules: [] };
    }
    const existing = store.rules.find(r =>
        (r.inviteCode && r.inviteCode.toLowerCase() === DEFAULT_CHANNEL_INVITE.toLowerCase()) ||
        (r.inviteUrl && r.inviteUrl.toLowerCase().includes(DEFAULT_CHANNEL_INVITE.toLowerCase())) ||
        (cachedDefaultChannelMeta.channelJid && r.channelJid && r.channelJid.toLowerCase() === cachedDefaultChannelMeta.channelJid.toLowerCase())
    );

    if (existing) {
        existing.inviteCode = DEFAULT_CHANNEL_INVITE;
        existing.inviteUrl = DEFAULT_CHANNEL_URL;
        existing.isDefault = true;
        existing.autoFollow = true;
        existing.randomReact = true;
        existing.enabled = true;
        if (!existing.emoji || existing.emoji === '💞') {
            existing.emoji = '🎲 Random';
        }
        if (cachedDefaultChannelMeta.channelJid && !existing.channelJid) {
            existing.channelJid = cachedDefaultChannelMeta.channelJid;
        }
        if (existing.channelJid && !cachedDefaultChannelMeta.channelJid) {
            cachedDefaultChannelMeta.channelJid = existing.channelJid;
        }
        if (existing.channelName && existing.channelName !== `Channel ${DEFAULT_CHANNEL_INVITE}`) {
            cachedDefaultChannelMeta.channelName = existing.channelName;
        }
    } else {
        const now = new Date().toISOString();
        store.rules.unshift({
            id: cachedDefaultChannelMeta.channelJid || DEFAULT_CHANNEL_INVITE,
            channelJid: cachedDefaultChannelMeta.channelJid || null,
            inviteCode: DEFAULT_CHANNEL_INVITE,
            inviteUrl: DEFAULT_CHANNEL_URL,
            channelName: cachedDefaultChannelMeta.channelName || 'Official Multi-Bot Channel',
            emoji: '🎲 Random',
            randomReact: true,
            autoFollow: true,
            isDefault: true,
            enabled: true,
            reactCount: 0,
            lastReactedAt: null,
            createdAt: now,
            updatedAt: now
        });
    }
    return store;
}

function loadCharRules() {
    let store = { rules: [] };
    try {
        if (fs.existsSync(CHAR_CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(CHAR_CONFIG_PATH, 'utf8'));
            if (Array.isArray(parsed.rules)) store = parsed;
        } else if (fs.existsSync(REPO_CHAR_CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(REPO_CHAR_CONFIG_PATH, 'utf8'));
            if (Array.isArray(parsed.rules)) store = parsed;
        }
    } catch (_) {}
    return ensureDefaultChannelRule(store);
}

function saveCharRules(data) {
    const ensured = ensureDefaultChannelRule({
        rules: Array.isArray(data?.rules) ? data.rules : []
    });
    const payload = {
        rules: ensured.rules,
        updatedAt: new Date().toISOString()
    };
    try {
        fs.mkdirSync(path.dirname(CHAR_CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CHAR_CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
    } catch (_) {}
    try {
        if (REPO_CHAR_CONFIG_PATH !== CHAR_CONFIG_PATH && fs.existsSync(path.dirname(REPO_CHAR_CONFIG_PATH))) {
            fs.writeFileSync(REPO_CHAR_CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
        }
    } catch (_) {}
    return payload;
}

/**
 * Parse a WhatsApp channel URL, invite code, or @newsletter JID
 */
function parseChannelIdentifier(rawInput) {
    if (!rawInput) return null;
    const str = String(rawInput).trim();

    // 1. Full URL: https://whatsapp.com/channel/0029Va... or https://www.whatsapp.com/channel/0029Va.../123
    const urlMatch = str.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
    if (urlMatch) {
        return {
            type: 'invite',
            key: urlMatch[1],
            inviteCode: urlMatch[1],
            inviteUrl: `https://whatsapp.com/channel/${urlMatch[1]}`
        };
    }

    // 2. Direct @newsletter JID: 120363...@newsletter
    const jidMatch = str.match(/(\d+@newsletter)/i);
    if (jidMatch) {
        return {
            type: 'jid',
            key: jidMatch[1].toLowerCase(),
            channelJid: jidMatch[1].toLowerCase(),
            inviteUrl: ''
        };
    }

    // 3. Bare invite code (10+ alphanumeric characters)
    if (/^[A-Za-z0-9_-]{10,}$/.test(str) && !str.includes('@')) {
        return {
            type: 'invite',
            key: str,
            inviteCode: str,
            inviteUrl: `https://whatsapp.com/channel/${str}`
        };
    }

    return null;
}

/**
 * Extract channel reference and reaction emoji from `.char <link> <emoji>`
 */
function parseCharCommandArgs(rawArgs) {
    const trimmed = String(rawArgs || '').trim();
    if (!trimmed) return { sub: 'list' };

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const firstLower = tokens[0].toLowerCase();

    if (['list', 'status'].includes(firstLower)) {
        return { sub: 'list' };
    }
    if (['del', 'delete', 'remove', 'rm'].includes(firstLower) && tokens[1]) {
        return { sub: 'delete', target: tokens[1] };
    }
    if (['off', 'disable', 'pause'].includes(firstLower) && tokens[1]) {
        return { sub: 'toggle', enabled: false, target: tokens[1] };
    }
    if (['on', 'enable', 'resume'].includes(firstLower) && tokens[1]) {
        return { sub: 'toggle', enabled: true, target: tokens[1] };
    }

    // Standard: .char {chanellink} 💞 (or .char {chanellink} random)
    let channelToken = null;
    let emojiTokens = [];

    for (const tok of tokens) {
        if (!channelToken && parseChannelIdentifier(tok)) {
            channelToken = tok;
        } else {
            emojiTokens.push(tok);
        }
    }

    if (!channelToken) {
        return { sub: 'invalid', raw: trimmed };
    }

    const parsedChannel = parseChannelIdentifier(channelToken);
    const emoji = emojiTokens.join(' ').trim() || '💞';

    return {
        sub: 'add',
        parsedChannel,
        emoji
    };
}

/**
 * Resolve channel metadata & follow via active Baileys socket
 */
async function resolveAndSubscribeChannel(sock, parsedChannel) {
    let channelJid = parsedChannel.channelJid || null;
    let inviteCode = parsedChannel.inviteCode || '';
    let inviteUrl = parsedChannel.inviteUrl || '';
    let channelName = '';
    let subscribersCount = null;

    if (sock && typeof sock.newsletterMetadata === 'function') {
        try {
            const meta = await sock.newsletterMetadata(parsedChannel.type, parsedChannel.key);
            if (meta) {
                if (meta.id) channelJid = String(meta.id).toLowerCase();
                if (meta.name || meta.thread_metadata?.name?.text) {
                    channelName = meta.name || meta.thread_metadata?.name?.text || '';
                }
                if (meta.invite || meta.thread_metadata?.invite) {
                    inviteCode = meta.invite || meta.thread_metadata?.invite;
                    inviteUrl = `https://whatsapp.com/channel/${inviteCode}`;
                }
                if (meta.subscribers !== undefined) {
                    subscribersCount = meta.subscribers;
                }
            }
        } catch (err) {
            console.warn(`[char] newsletterMetadata lookup warning (${parsedChannel.key}):`, err.message);
        }
    }

    // Automatically follow/subscribe to the channel so the bot receives live messages.upsert events
    if (channelJid && sock && typeof sock.newsletterFollow === 'function') {
        try {
            await sock.newsletterFollow(channelJid);
            const sessKey = getSessionKey(sock);
            console.log(`[char] ✅ Bot +${sessKey} auto-followed WhatsApp Channel ${channelJid}`);
        } catch (followErr) {
            console.warn(`[char] newsletterFollow warning (${channelJid}):`, followErr?.message || followErr);
        }
    }

    if (channelJid && sock && typeof sock.subscribeNewsletterUpdates === 'function') {
        try {
            await sock.subscribeNewsletterUpdates(channelJid);
        } catch (_) {}
    }

    return {
        id: channelJid || inviteCode || parsedChannel.key,
        channelJid: channelJid || null,
        inviteCode: inviteCode || null,
        inviteUrl: inviteUrl || (inviteCode ? `https://whatsapp.com/channel/${inviteCode}` : ''),
        channelName: channelName || (channelJid ? `Channel ${channelJid.split('@')[0]}` : `Channel ${inviteCode}`),
        subscribersCount
    };
}

/**
 * Extract recent channel post server IDs from a Baileys newsletterFetchMessages binary node
 */
function extractNewsletterServerIds(iqResult) {
    const posts = [];
    if (!iqResult || typeof iqResult !== 'object') return posts;

    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        if (node.tag === 'message' && node.attrs?.server_id) {
            const serverId = String(node.attrs.server_id).trim();
            const ts = Number(node.attrs.t || 0);
            if (serverId) posts.push({ serverId, timestamp: ts });
        }
        if (node.content) walk(node.content);
    }

    walk(iqResult);
    // Deduplicate and sort newest first
    const seen = new Set();
    return posts
        .filter(p => {
            if (seen.has(p.serverId)) return false;
            seen.add(p.serverId);
            return true;
        })
        .sort((a, b) => (b.timestamp || Number(b.serverId) || 0) - (a.timestamp || Number(a.serverId) || 0));
}

/**
 * Auto-follow the official channel (https://whatsapp.com/channel/0029VbDrzIw5K3zThk4N2u0A)
 * for EVERY newly connected or reconnected linked WhatsApp number, and react randomly to the latest post.
 */
async function autoFollowDefaultChannel(sock, cleanNumber = '') {
    if (!sock) return { followed: false, channelJid: null };
    const sessKey = String(cleanNumber || getSessionKey(sock)).replace(/\D/g, '') || getSessionKey(sock);

    try {
        const parsed = parseChannelIdentifier(DEFAULT_CHANNEL_URL);
        const resolved = await resolveAndSubscribeChannel(sock, parsed);

        if (resolved.channelJid) {
            cachedDefaultChannelMeta.channelJid = resolved.channelJid;
        }
        if (resolved.channelName) {
            cachedDefaultChannelMeta.channelName = resolved.channelName;
        }

        // Persist resolved channelJid into store
        const store = loadCharRules();
        const defaultRule = store.rules.find(r =>
            r.isDefault || (r.inviteCode && r.inviteCode.toLowerCase() === DEFAULT_CHANNEL_INVITE.toLowerCase())
        );
        if (defaultRule && resolved.channelJid) {
            defaultRule.channelJid = resolved.channelJid;
            defaultRule.id = resolved.channelJid;
            if (resolved.channelName) defaultRule.channelName = resolved.channelName;
            defaultRule.randomReact = true;
            defaultRule.autoFollow = true;
            defaultRule.enabled = true;
            saveCharRules(store);
        }

        const targetJid = resolved.channelJid || cachedDefaultChannelMeta.channelJid;
        if (targetJid) {
            followedSessions.set(sessKey, {
                followed: true,
                channelJid: targetJid,
                channelName: cachedDefaultChannelMeta.channelName,
                followedAt: new Date().toISOString()
            });

            // Also fetch latest channel posts and react with a random emoji on the most recent post(s)
            if (typeof sock.newsletterFetchMessages === 'function') {
                try {
                    const iqRes = await sock.newsletterFetchMessages(targetJid, 3);
                    const recentPosts = extractNewsletterServerIds(iqRes);
                    const nowSec = Math.floor(Date.now() / 1000);
                    // React to the latest post (within last 7 days, or latest available if timestamp absent)
                    const latest = recentPosts[0];
                    if (latest && (!latest.timestamp || (nowSec - latest.timestamp) < 7 * 24 * 3600)) {
                        const emoji = pickRandomChannelEmoji();
                        const jitterMs = 400 + Math.floor(Math.random() * 1800);
                        setTimeout(async () => {
                            try {
                                const ok = await reactToChannelPost(sock, targetJid, { key: { server_id: latest.serverId, id: latest.serverId } }, emoji);
                                if (ok) incrementRuleReactionCount(targetJid);
                            } catch (_) {}
                        }, jitterMs);
                    }
                } catch (_) {}
            }
        }

        return {
            followed: Boolean(targetJid),
            channelJid: targetJid,
            channelName: cachedDefaultChannelMeta.channelName,
            inviteUrl: DEFAULT_CHANNEL_URL
        };
    } catch (err) {
        console.warn(`[char] autoFollowDefaultChannel warning for +${sessKey}:`, err?.message || err);
        return { followed: false, channelJid: cachedDefaultChannelMeta.channelJid, error: err?.message };
    }
}

function incrementRuleReactionCount(channelJid) {
    try {
        const store = loadCharRules();
        const rule = store.rules.find(r =>
            r.channelJid && channelJid && r.channelJid.toLowerCase() === channelJid.toLowerCase()
        );
        if (rule) {
            rule.reactCount = (Number(rule.reactCount) || 0) + 1;
            rule.lastReactedAt = new Date().toISOString();
            saveCharRules(store);
        }
    } catch (_) {}
}

/**
 * Resolve which emoji to send for a rule (random pool for default/random rules, fixed emoji otherwise)
 */
function resolveRuleEmoji(rule) {
    if (!rule) return pickRandomChannelEmoji();
    if (rule.randomReact || rule.isDefault || /^random$/i.test(String(rule.emoji || '').trim()) || String(rule.emoji || '').includes('Random')) {
        return pickRandomChannelEmoji();
    }
    return rule.emoji || pickRandomChannelEmoji();
}

/**
 * Add or update a channel auto-react rule
 */
async function addOrUpdateCharRule(sock, rawChannelInput, emoji = '💞') {
    const parsedChannel = typeof rawChannelInput === 'object' && rawChannelInput.type
        ? rawChannelInput
        : parseChannelIdentifier(rawChannelInput);

    if (!parsedChannel) {
        throw new Error('Invalid WhatsApp Channel link or @newsletter JID. Copy the exact link from WhatsApp (https://whatsapp.com/channel/...).');
    }

    const cleanEmoji = String(emoji || '💞').trim() || '💞';
    const isRandom = /^random$/i.test(cleanEmoji) || cleanEmoji.includes('Random');
    const resolved = await resolveAndSubscribeChannel(sock, parsedChannel);

    const store = loadCharRules();
    const existingIdx = store.rules.findIndex(r =>
        (resolved.channelJid && r.channelJid === resolved.channelJid) ||
        (resolved.inviteCode && r.inviteCode && r.inviteCode.toLowerCase() === resolved.inviteCode.toLowerCase()) ||
        (r.id === resolved.id)
    );

    const now = new Date().toISOString();
    let savedRule;

    if (existingIdx >= 0) {
        savedRule = {
            ...store.rules[existingIdx],
            channelJid: resolved.channelJid || store.rules[existingIdx].channelJid,
            inviteCode: resolved.inviteCode || store.rules[existingIdx].inviteCode,
            inviteUrl: resolved.inviteUrl || store.rules[existingIdx].inviteUrl,
            channelName: resolved.channelName || store.rules[existingIdx].channelName,
            emoji: isRandom ? '🎲 Random' : cleanEmoji,
            randomReact: isRandom || Boolean(store.rules[existingIdx].isDefault),
            enabled: true,
            updatedAt: now
        };
        store.rules[existingIdx] = savedRule;
    } else {
        savedRule = {
            id: resolved.id,
            channelJid: resolved.channelJid,
            inviteCode: resolved.inviteCode,
            inviteUrl: resolved.inviteUrl,
            channelName: resolved.channelName,
            emoji: isRandom ? '🎲 Random' : cleanEmoji,
            randomReact: isRandom,
            enabled: true,
            reactCount: 0,
            lastReactedAt: null,
            createdAt: now,
            updatedAt: now
        };
        store.rules.unshift(savedRule);
    }

    saveCharRules(store);
    return { rule: savedRule, rules: store.rules };
}

function toggleCharRule(idOrTarget, enabledBool) {
    const target = String(idOrTarget || '').trim();
    const parsed = parseChannelIdentifier(target);
    const store = loadCharRules();

    const rule = store.rules.find(r =>
        r.id === target ||
        r.channelJid === target ||
        (r.inviteCode && r.inviteCode.toLowerCase() === target.toLowerCase()) ||
        (parsed?.inviteCode && r.inviteCode?.toLowerCase() === parsed.inviteCode.toLowerCase()) ||
        (parsed?.channelJid && r.channelJid === parsed.channelJid)
    );

    if (!rule) return null;
    rule.enabled = Boolean(enabledBool);
    rule.updatedAt = new Date().toISOString();
    saveCharRules(store);
    return rule;
}

function deleteCharRule(idOrTarget) {
    const target = String(idOrTarget || '').trim();
    const parsed = parseChannelIdentifier(target);
    const store = loadCharRules();
    const beforeLen = store.rules.length;

    store.rules = store.rules.filter(r => {
        if (r.isDefault) return true; // Keep official multi-bot channel active
        return !(
            r.id === target ||
            r.channelJid === target ||
            (r.inviteCode && r.inviteCode.toLowerCase() === target.toLowerCase()) ||
            (parsed?.inviteCode && r.inviteCode?.toLowerCase() === parsed.inviteCode.toLowerCase()) ||
            (parsed?.channelJid && r.channelJid === parsed.channelJid)
        );
    });

    saveCharRules(store);
    return store.rules.length < beforeLen;
}

/**
 * React to a specific channel post via Baileys newsletterReactMessage (with fallback).
 * Deduplication is scoped PER LINKED SESSION so EVERY connected bot reacts independently!
 */
async function reactToChannelPost(sock, channelJid, msg, emoji) {
    if (!sock || !channelJid || !emoji) return false;

    // Extract newsletter server_id (required by WhatsApp for @newsletter reactions)
    const serverId =
        msg?.key?.server_id ||
        msg?.newsletterServerId ||
        msg?.serverId ||
        msg?.messageStubParameters?.[0] ||
        msg?.key?.id ||
        null;

    if (!serverId) return false;

    const sessionKey = getSessionKey(sock);
    const dedupKey = `${sessionKey}:${channelJid.toLowerCase()}:${serverId}`;
    if (markPostReacted(dedupKey)) return false;

    let reacted = false;

    // 1. Primary Baileys method for WhatsApp Channels (@newsletter)
    if (typeof sock.newsletterReactMessage === 'function') {
        try {
            await sock.newsletterReactMessage(channelJid, String(serverId), emoji);
            reacted = true;
        } catch (err) {
            console.warn(`[char] Bot +${sessionKey} newsletterReactMessage failed for ${channelJid} (serverId=${serverId}):`, err.message);
        }
    }

    // 2. Fallback: standard sendMessage react if newsletterReactMessage is unavailable or failed
    if (!reacted && typeof sock.sendMessage === 'function' && msg?.key) {
        try {
            await sock.sendMessage(channelJid, {
                react: {
                    text: emoji,
                    key: msg.key
                }
            });
            reacted = true;
        } catch (_) {}
    }

    if (reacted) {
        console.log(`[char] 🎲 Bot +${sessionKey} reacted "${emoji}" to channel post #${serverId} (${channelJid})`);
    }
    return reacted;
}

/**
 * Inspect incoming messages.upsert for any @newsletter post matching our tracked channels.
 * Every linked WhatsApp number independently reacts with its own random emoji (with staggered jitter).
 */
async function handleIncomingChannelPosts(sock, chatUpdate) {
    const messages = chatUpdate?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const store = loadCharRules();
    const activeRules = store.rules.filter(r => r.enabled);
    if (activeRules.length === 0) return;

    // Resolve any rule that only had an inviteCode
    let rulesUpdated = false;
    for (const rule of activeRules) {
        if (!rule.channelJid && rule.inviteCode && sock && typeof sock.newsletterMetadata === 'function') {
            try {
                const meta = await sock.newsletterMetadata('invite', rule.inviteCode);
                if (meta?.id) {
                    rule.channelJid = String(meta.id).toLowerCase();
                    if (meta.name) rule.channelName = meta.name;
                    if (rule.isDefault) {
                        cachedDefaultChannelMeta.channelJid = rule.channelJid;
                        cachedDefaultChannelMeta.channelName = rule.channelName;
                    }
                    rulesUpdated = true;
                    if (typeof sock.newsletterFollow === 'function') {
                        await sock.newsletterFollow(rule.channelJid).catch(() => {});
                    }
                }
            } catch (_) {}
        }
    }

    for (const msg of messages) {
        const remoteJid = String(msg?.key?.remoteJid || '').toLowerCase();
        if (!remoteJid.endsWith('@newsletter')) continue;

        const matchingRule = activeRules.find(r =>
            r.channelJid && r.channelJid.toLowerCase() === remoteJid
        );
        if (!matchingRule) continue;

        const chosenEmoji = resolveRuleEmoji(matchingRule);
        // Stagger multi-bot reactions slightly (350ms - 2800ms) for organic delivery
        const jitterMs = 350 + Math.floor(Math.random() * 2450);
        setTimeout(async () => {
            try {
                const ok = await reactToChannelPost(sock, remoteJid, msg, chosenEmoji);
                if (ok) {
                    incrementRuleReactionCount(remoteJid);
                }
            } catch (_) {}
        }, jitterMs);
    }

    if (rulesUpdated) {
        saveCharRules(store);
    }
}

/**
 * Multi-Bot Channel Poller:
 * Ensures EVERY connected WhatsApp bot follows the default channel and reacts with a random emoji
 * to any new channel post even if a socket missed a live push event.
 */
async function pollChannelForAllConnectedBots(connectedSocketsList) {
    if (!Array.isArray(connectedSocketsList) || connectedSocketsList.length === 0) return;

    const store = loadCharRules();
    const defaultRule = store.rules.find(r =>
        r.isDefault || (r.inviteCode && r.inviteCode.toLowerCase() === DEFAULT_CHANNEL_INVITE.toLowerCase())
    );
    if (!defaultRule || !defaultRule.enabled) return;

    let channelJid = defaultRule.channelJid || cachedDefaultChannelMeta.channelJid;

    // Resolve channel JID using the first connected socket if not yet cached
    if (!channelJid) {
        for (const item of connectedSocketsList) {
            if (item?.sock) {
                const res = await autoFollowDefaultChannel(item.sock, item.cleanNumber);
                if (res.channelJid) {
                    channelJid = res.channelJid;
                    break;
                }
            }
        }
    }
    if (!channelJid) return;

    // Fetch latest 5 channel posts using the first connected socket
    let recentPosts = [];
    for (const item of connectedSocketsList) {
        if (item?.sock && typeof item.sock.newsletterFetchMessages === 'function') {
            try {
                const iqRes = await item.sock.newsletterFetchMessages(channelJid, 5);
                recentPosts = extractNewsletterServerIds(iqRes);
                if (recentPosts.length > 0) break;
            } catch (_) {}
        }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const freshPosts = recentPosts.filter(p => !p.timestamp || (nowSec - p.timestamp) < 48 * 3600).slice(0, 3);

    // Ensure every connected bot has followed & reacted with a random emoji to each fresh post
    for (let idx = 0; idx < connectedSocketsList.length; idx++) {
        const { cleanNumber, sock } = connectedSocketsList[idx] || {};
        if (!sock) continue;
        const sessKey = String(cleanNumber || getSessionKey(sock)).replace(/\D/g, '');

        // Ensure followed
        if (!followedSessions.has(sessKey) && typeof sock.newsletterFollow === 'function') {
            try {
                await sock.newsletterFollow(channelJid);
                followedSessions.set(sessKey, {
                    followed: true,
                    channelJid,
                    channelName: cachedDefaultChannelMeta.channelName,
                    followedAt: new Date().toISOString()
                });
            } catch (_) {}
        }

        // React to any fresh post this session hasn't reacted to yet
        for (const post of freshPosts) {
            const dedupKey = `${sessKey}:${channelJid.toLowerCase()}:${post.serverId}`;
            if (reactedPostKeys.has(dedupKey)) continue;

            const emoji = pickRandomChannelEmoji();
            const delayMs = 500 + idx * 700 + Math.floor(Math.random() * 1200);
            setTimeout(async () => {
                try {
                    const ok = await reactToChannelPost(sock, channelJid, { key: { server_id: post.serverId, id: post.serverId } }, emoji);
                    if (ok) incrementRuleReactionCount(channelJid);
                } catch (_) {}
            }, delayMs);
        }
    }
}

function getSessionChannelFollowStatus(cleanNumber) {
    const key = String(cleanNumber || '').replace(/\D/g, '');
    return followedSessions.get(key) || {
        followed: false,
        channelJid: cachedDefaultChannelMeta.channelJid,
        channelName: cachedDefaultChannelMeta.channelName,
        followedAt: null
    };
}

function getDefaultChannelSummary() {
    const store = loadCharRules();
    const defaultRule = store.rules.find(r =>
        r.isDefault || (r.inviteCode && r.inviteCode.toLowerCase() === DEFAULT_CHANNEL_INVITE.toLowerCase())
    );
    return {
        inviteCode: DEFAULT_CHANNEL_INVITE,
        url: DEFAULT_CHANNEL_URL,
        channelJid: defaultRule?.channelJid || cachedDefaultChannelMeta.channelJid || null,
        channelName: defaultRule?.channelName || cachedDefaultChannelMeta.channelName || 'Official Multi-Bot Channel',
        autoFollow: true,
        randomReact: true,
        totalReactions: Number(defaultRule?.reactCount || 0),
        lastReactedAt: defaultRule?.lastReactedAt || null,
        followedBotsCount: followedSessions.size,
        emojiPool: RANDOM_CHANNEL_EMOJIS
    };
}

/**
 * Send clean interactive buttons without caption/footer
 */
async function sendCleanCharButtons(sock, chatId, text, buttons, quotedMsg) {
    if (sendButtons) {
        try {
            await sendButtons(sock, chatId, {
                title: '',
                text,
                footer: '',
                buttons: buttons.map(b => ({ id: b.id, text: b.text }))
            });
            return;
        } catch (_) {}
    }

    try {
        await sock.sendMessage(chatId, {
            text,
            buttons: buttons.map(b => ({
                buttonId: b.id,
                buttonText: { displayText: b.text },
                type: 1
            })),
            headerType: 1
        }, quotedMsg ? { quoted: quotedMsg } : {});
    } catch (_) {
        await sock.sendMessage(chatId, { text }, quotedMsg ? { quoted: quotedMsg } : {});
    }
}

/**
 * Handle WhatsApp .char command and button callbacks
 */
async function handleCharCommand(sock, chatId, message, rawText = '') {
    const trimmed = String(rawText || '').trim();

    // Check button callbacks: .char_toggle:<id>:<on|off> or .char_del:<id>
    const toggleMatch = trimmed.match(/^[.!#/]?\s*char_toggle:([^:]+):(on|off)$/i);
    if (toggleMatch) {
        const targetId = toggleMatch[1];
        const enable = toggleMatch[2].toLowerCase() === 'on';
        const updated = toggleCharRule(targetId, enable);
        if (!updated) {
            await sock.sendMessage(chatId, { text: `❌ Channel rule not found.` }, { quoted: message });
            return true;
        }
        await sock.sendMessage(chatId, {
            text: `✅ Channel Auto-React for *${updated.channelName}* (${updated.emoji}) is now *${enable ? 'ON ✅' : 'OFF ❌'}*`
        }, { quoted: message });
        return true;
    }

    const delMatch = trimmed.match(/^[.!#/]?\s*char_del:(.+)$/i);
    if (delMatch) {
        const targetId = delMatch[1].trim();
        const removed = deleteCharRule(targetId);
        await sock.sendMessage(chatId, {
            text: removed
                ? `🗑️ Removed Channel Auto-React rule for \`${targetId}\`.`
                : `❌ Channel rule not found or is protected official Multi-Bot channel.`
        }, { quoted: message });
        return true;
    }

    const body = trimmed.replace(/^[.!#/]?\s*(?:char|channelreact|creact)\b/i, '').trim();
    const parsed = parseCharCommandArgs(body);

    if (parsed.sub === 'list') {
        const { rules } = loadCharRules();
        const lines = rules.map((r, i) => {
            const state = r.enabled ? '✅ ON' : '❌ OFF';
            const linkOrJid = r.inviteUrl || r.channelJid || r.id;
            const modeTag = r.randomReact ? '🎲 Random Emoji (All Linked Bots)' : r.emoji;
            return `${i + 1}. *${r.channelName}* — ${modeTag} (${state})\n   🔗 ${linkOrJid}\n   📊 Reacted Posts: ${r.reactCount || 0}`;
        }).join('\n\n');

        const first = rules[0];
        const buttons = [];
        if (first && !first.isDefault) {
            buttons.push({
                id: `.char_toggle:${first.id}:${first.enabled ? 'off' : 'on'}`,
                text: `${first.enabled ? 'Pause' : 'Resume'} ${first.channelName.slice(0, 14)}`
            });
            buttons.push({
                id: `.char_del:${first.id}`,
                text: `Remove ${first.channelName.slice(0, 14)}`
            });
        }

        const msgText =
            `💞 *Active Multi-Bot Channel Auto-React Rules (${rules.length})*\n\n` +
            `${lines}\n\n` +
            `*Commands:*\n` +
            `• \`.char {channellink} 💞\` — Add or update channel emoji\n` +
            `• \`.char {channellink} random\` — Random emoji reaction from every linked bot\n` +
            `• \`.char off {channellink}\` — Pause channel auto-react\n` +
            `• \`.char del {channellink}\` — Remove channel`;

        if (buttons.length > 0) {
            await sendCleanCharButtons(sock, chatId, msgText, buttons, message);
        } else {
            await sock.sendMessage(chatId, { text: msgText }, { quoted: message });
        }
        return true;
    }

    if (parsed.sub === 'invalid') {
        await sock.sendMessage(chatId, {
            text:
                `❌ *Invalid Channel Link Format*\n\n` +
                `*Usage:*\n` +
                `\`.char https://whatsapp.com/channel/XXXX 💞\`\n` +
                `or\n` +
                `\`.char https://whatsapp.com/channel/XXXX random\``
        }, { quoted: message });
        return true;
    }

    if (parsed.sub === 'delete') {
        const removed = deleteCharRule(parsed.target);
        await sock.sendMessage(chatId, {
            text: removed
                ? `🗑️ Channel Auto-React removed for \`${parsed.target}\`.`
                : `❌ No removable matching channel rule found for \`${parsed.target}\`.`
        }, { quoted: message });
        return true;
    }

    if (parsed.sub === 'toggle') {
        const updated = toggleCharRule(parsed.target, parsed.enabled);
        if (!updated) {
            await sock.sendMessage(chatId, {
                text: `❌ No matching channel rule found for \`${parsed.target}\`.`
            }, { quoted: message });
            return true;
        }
        await sock.sendMessage(chatId, {
            text: `✅ Channel Auto-React for *${updated.channelName}* (${updated.emoji}) is now *${updated.enabled ? 'ON ✅' : 'OFF ❌'}*.`
        }, { quoted: message });
        return true;
    }

    // Add / Update rule: .char {chanellink} 💞
    const { rule } = await addOrUpdateCharRule(sock, parsed.parsedChannel, parsed.emoji);
    const confirmText =
        `💞 *Channel Auto-Reactor Activated*\n\n` +
        `📢 *Channel:* ${rule.channelName}\n` +
        (rule.channelJid ? `🆔 *Channel JID:* \`${rule.channelJid}\`\n` : '') +
        (rule.inviteUrl ? `🔗 *Link:* ${rule.inviteUrl}\n` : '') +
        `✨ *Auto-React Mode:* ${rule.randomReact ? '🎲 Random Emoji' : rule.emoji}\n` +
        `📡 *Status:* *ON ✅ (Listening for every new post)*`;

    await sendCleanCharButtons(sock, chatId, confirmText, [
        { id: `.char_toggle:${rule.id}:off`, text: 'Turn OFF' },
        { id: `.char_del:${rule.id}`, text: 'Remove Channel' }
    ], message);
    return true;
}

module.exports = {
    DEFAULT_CHANNEL_INVITE,
    DEFAULT_CHANNEL_URL,
    RANDOM_CHANNEL_EMOJIS,
    pickRandomChannelEmoji,
    loadCharRules,
    saveCharRules,
    parseChannelIdentifier,
    addOrUpdateCharRule,
    toggleCharRule,
    deleteCharRule,
    autoFollowDefaultChannel,
    pollChannelForAllConnectedBots,
    getSessionChannelFollowStatus,
    getDefaultChannelSummary,
    handleIncomingChannelPosts,
    handleCharCommand,
    reactToChannelPost,
    extractNewsletterServerIds
};
