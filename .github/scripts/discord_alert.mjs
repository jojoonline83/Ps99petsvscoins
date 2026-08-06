import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const WEBHOOKS = {
    main: process.env.DISCORD_WEBHOOK,
    wintheasura: process.env.DISCORD_WEBHOOK_WINTHEASURA,
};
const API_BASE = 'https://ps99.biggamesapi.io/v1';
const HISTORY_FILE = 'league_history.json';
const ALERT_STATE_FILE = 'alert_state.json';

const WATCHED_PLAYERS = [
    { username: 'Jojo8', userId: 3079452920, channels: ['main'], mention: '967089828837597264' },
    { username: 'javierplayz', userId: null, channels: ['main'], mention: '967089828837597264' },
    { username: 'wintheasura', userId: null, channels: ['main', 'wintheasura'], mention: '285683307046240257' },
    { username: 'doughboy', userId: null, channels: ['wintheasura'], mention: '1029960452077277195' },
    { username: 'diskobull', userId: null, channels: ['wintheasura'], mention: '864881039398928385' },
    { username: 'e_ethan', userId: null, channels: ['wintheasura'], mention: ['1229756317804265503', '1162921964831256608'] },
];

const WINDOWS = [
    { label: '10 min', ms: 10 * 60_000, tol: 15 * 60_000 },
    { label: '30 min', ms: 30 * 60_000, tol: 15 * 60_000 },
    { label: '60 min', ms: 60 * 60_000, tol: 20 * 60_000 },
];

async function fetchJson(url, opts = {}) {
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(15000), ...opts });
            if (res.ok) return await res.json();
        } catch (_) {}
        if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
    return null;
}

async function resolveUsername(username) {
    const json = await fetchJson('https://users.roblox.com/v1/usernames/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    return json?.data?.[0] || null;
}

async function getPlayerFromLeagueApi(userId) {
    const json = await fetchJson(`${API_BASE}/leagues/players/${userId}`);
    if (json?.status === 'ok' && json.data) return json.data;
    return null;
}

function findPlayerInHistory(history, userId) {
    const results = [];
    for (const snap of history) {
        let found = null;
        for (const league of (snap.leagues || [])) {
            for (const p of (league.roster || [])) {
                if (p.UserID === userId) { found = { ...p, Clan: league.Name }; break; }
            }
            if (found) break;
        }
        results.push({ ts: snap.ts, player: found });
    }
    return results;
}

function findSnapshotNear(snapshots, msAgo, toleranceMs) {
    if (snapshots.length < 2) return null;
    const latest = snapshots[snapshots.length - 1];
    const targetTs = latest.ts - msAgo;
    const minAgeMs = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of snapshots) {
        if (entry === latest) continue;
        if (latest.ts - entry.ts < minAgeMs) continue;
        if (!entry.player) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

async function sendToWebhook(webhookUrl, embeds, mentions = []) {
    if (!webhookUrl) return;
    const payload = { embeds };
    if (mentions.length) payload.content = [...new Set(mentions)].map(id => `<@${id}>`).join(' ');
    await fetchJson(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

// --- Main ---
if (!WEBHOOKS.main) {
    console.error('DISCORD_WEBHOOK env var not set.');
    process.exit(1);
}

let history = [];
if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch (_) {}
}

let alertState = {};
if (existsSync(ALERT_STATE_FILE)) {
    try { alertState = JSON.parse(readFileSync(ALERT_STATE_FILE, 'utf8')); } catch (_) { alertState = {}; }
}

const now = Date.now();
const embedsByChannel = {};
const mentionsByChannel = {};

for (const player of WATCHED_PLAYERS) {
    let userId = player.userId;
    let displayName = player.username;

    if (!userId) {
        const resolved = await resolveUsername(player.username);
        if (resolved) {
            userId = resolved.id;
            displayName = resolved.displayName || resolved.name || player.username;
            console.log(`Resolved ${player.username} → ID ${userId} (display: ${displayName})`);
        } else {
            console.log(`Could not resolve username: ${player.username}`);
            continue;
        }
    }

    const playerHistory = findPlayerInHistory(history, userId);
    const latestSnap = playerHistory.length ? playerHistory[playerHistory.length - 1] : null;

    let currentPoints = latestSnap?.player?.Points;
    let clan = latestSnap?.player?.Clan || '—';

    if (currentPoints === undefined || currentPoints === null) {
        const liveData = await getPlayerFromLeagueApi(userId);
        if (liveData) {
            currentPoints = liveData.Points || 0;
            displayName = liveData.DisplayName || displayName;
            clan = liveData.League || liveData.LeagueName || clan;
        }
    }

    if (currentPoints === undefined || currentPoints === null) {
        console.log(`No data found for ${displayName} (${userId})`);
        continue;
    }

    const stateKey = String(userId);
    if (!alertState[stateKey]) alertState[stateKey] = { points: [], lastAlerted: {} };
    const ps = alertState[stateKey];

    ps.points.push({ ts: now, pts: currentPoints });
    ps.points = ps.points.filter(e => now - e.ts <= 95 * 60_000);

    const zeroWindows = [];
    for (const w of WINDOWS) {
        const histSnap = findSnapshotNear(playerHistory, w.ms, w.tol);

        let pastPoints = histSnap?.player?.Points;

        if (pastPoints === undefined) {
            const pastEntry = ps.points.find((e, i, arr) => {
                const age = now - e.ts;
                return age >= w.ms / 2 && Math.abs(age - w.ms) <= w.tol;
            });
            if (pastEntry) pastPoints = pastEntry.pts;
        }

        if (pastPoints !== undefined && currentPoints - pastPoints === 0) {
            zeroWindows.push(w.label);
        }
    }

    if (zeroWindows.length > 0) {
        const alertKey = zeroWindows.join(',');
        const lastAlerted = ps.lastAlerted[alertKey] || 0;
        const cooldownMs = 10 * 60_000;

        if (now - lastAlerted > cooldownMs) {
            const embed = {
                title: `⚠️ ${displayName} — No Point Gain`,
                description: `**${displayName}** has **0 points gained** in the last **${zeroWindows.join(', ')}**.`,
                color: 0xff4444,
                fields: [
                    { name: 'Current Points', value: currentPoints.toLocaleString(), inline: true },
                    { name: 'League', value: clan, inline: true },
                    { name: 'Zero-gain Windows', value: zeroWindows.join(', '), inline: true },
                ],
                timestamp: new Date().toISOString(),
                footer: { text: 'PS99 League Tracker' },
            };
            for (const ch of (player.channels || ['main'])) {
                if (!embedsByChannel[ch]) embedsByChannel[ch] = [];
                if (!mentionsByChannel[ch]) mentionsByChannel[ch] = [];
                embedsByChannel[ch].push(embed);
                const ms = Array.isArray(player.mention) ? player.mention : player.mention ? [player.mention] : [];
                mentionsByChannel[ch].push(...ms);
            }
            ps.lastAlerted[alertKey] = now;
            console.log(`Alert: ${displayName} zero gain in ${zeroWindows.join(', ')} → ${player.channels.join(', ')}`);
        } else {
            console.log(`Skipping alert for ${displayName} (cooldown active)`);
        }
    } else {
        console.log(`${displayName}: gaining points normally (${currentPoints} pts)`);
    }
}

let totalSent = 0;
for (const [channel, embeds] of Object.entries(embedsByChannel)) {
    const url = WEBHOOKS[channel];
    if (!url) { console.log(`No webhook configured for channel "${channel}" — skipping.`); continue; }
    await sendToWebhook(url, embeds, mentionsByChannel[channel] || []);
    totalSent += embeds.length;
    console.log(`Sent ${embeds.length} alert(s) to ${channel} channel.`);
}
if (totalSent === 0) console.log('No alerts to send.');

writeFileSync(ALERT_STATE_FILE, JSON.stringify(alertState));
