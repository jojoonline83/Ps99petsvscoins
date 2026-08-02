import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API_BASE           = 'https://ps99.biggamesapi.io/v1';
const HISTORY_FILE       = 'league_history.json';
const RESOLVED_CACHE_FILE = 'resolved_names.json';
const RETENTION_MS       = 95 * 60 * 1000;
const TOP_PAGES          = 10;    // 10 pages * 100 = 1000 leagues
const PAGE_SIZE          = 100;
const DETAIL_CONCURRENCY = 25;

async function fetchJson(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (res.ok) {
                const json = await res.json();
                if (json.status === 'ok') return json;
            }
        } catch (_) {}
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
    return null;
}

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function isUnresolvedName(entry) {
    return entry.DisplayName === String(entry.UserID);
}

async function resolveUsernames(userIds) {
    const map = {};
    const ROBLOX_URL = 'https://users.roblox.com/v1/users';
    const batches = [];
    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100);
        if (batch.length) batches.push(batch);
    }

    async function resolveBatch(batch) {
        for (let attempt = 1; attempt <= 4; attempt++) {
            try {
                const res = await fetch(ROBLOX_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }),
                    signal: AbortSignal.timeout(10000),
                });
                if (res.ok) {
                    const json = await res.json();
                    const data = json.data || [];
                    if (data.length > 0) {
                        data.forEach(u => { map[u.id] = u.displayName || u.name; });
                        return true;
                    }
                    await new Promise(r => setTimeout(r, 1500 * attempt));
                } else if (res.status === 429) {
                    const retryAfter = Number(res.headers.get('retry-after')) || 0;
                    await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, 1500 * attempt)));
                } else {
                    await new Promise(r => setTimeout(r, 500 * attempt));
                }
            } catch (_) {
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
        return false;
    }

    const results = await mapWithConcurrency(batches, 5, resolveBatch);
    const failedBatches = results.filter(ok => !ok).length;
    if (failedBatches) console.log(`resolveUsernames: ${failedBatches} batch(es) never succeeded after retries.`);
    return map;
}

const startedAt = Date.now();

// 1. Fetch top 500 league summaries
const summaries = [];
for (let page = 1; page <= TOP_PAGES; page++) {
    const json = await fetchJson(`${API_BASE}/leagues?page=${page}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
    const leagues = json?.data?.leagues;
    if (!Array.isArray(leagues) || !leagues.length) break;
    for (const l of leagues) {
        summaries.push({
            ID: l.ID,
            Name: l.Name,
            Points: l.Points || 0,
            Members: l.Members || 0,
            MemberCapacity: l.MemberCapacity || 0,
            Level: l.Level || 0,
        });
        if (summaries.length >= 1000) break;
    }
    if (summaries.length >= 500) break;
}

if (!summaries.length) {
    console.error('No league data returned — skipping this snapshot.');
    process.exit(0);
}

console.log(`Fetched ${summaries.length} league summaries. Fetching detail…`);

// 2. Fetch detail for each league (roster + point contributions)
const leagues = await mapWithConcurrency(summaries, DETAIL_CONCURRENCY, async summary => {
    const detailJson = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(summary.Name)}`);
    const detail = detailJson?.data;

    if (!detail) {
        return { ...summary, roster: [] };
    }

    const contribByUser = {};
    (detail.PointContributions || []).forEach(c => {
        contribByUser[c.UserID] = c.Points;
    });

    const roster = [];
    if (detail.Owner?.UserID) {
        roster.push({
            UserID: detail.Owner.UserID,
            DisplayName: detail.Owner.DisplayName || String(detail.Owner.UserID),
            Points: contribByUser[detail.Owner.UserID] ?? 0,
            Role: 'Owner',
        });
    }
    for (const m of (detail.Members || [])) {
        roster.push({
            UserID: m.UserID,
            DisplayName: m.DisplayName || String(m.UserID),
            Points: contribByUser[m.UserID] ?? 0,
            Role: 'Member',
        });
    }

    roster.sort((a, b) => b.Points - a.Points);

    return {
        ID: detail.ID || summary.ID,
        Name: detail.Name || summary.Name,
        Points: detail.Points || summary.Points,
        Members: roster.length,
        MemberCapacity: detail.MemberCapacity || summary.MemberCapacity,
        Level: detail.Level ?? summary.Level,
        roster,
    };
});

// 3. Resolve numeric display names via Roblox API
let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

const needsResolve = new Set();
leagues.forEach(l => l.roster.forEach(p => {
    if (!isUnresolvedName(p)) return;
    if (resolvedCache[p.UserID]) { p.DisplayName = resolvedCache[p.UserID]; return; }
    needsResolve.add(p.UserID);
}));

if (needsResolve.size) {
    const resolved = await resolveUsernames([...needsResolve]);
    leagues.forEach(l => l.roster.forEach(p => {
        if (isUnresolvedName(p) && resolved[p.UserID]) p.DisplayName = resolved[p.UserID];
    }));
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.size} new display names (${Object.keys(resolvedCache).length} cached total).`);
}
writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

// 4. Append snapshot and prune old entries
let history = [];
if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { history = []; }
}

const now = Date.now();
history.push({ ts: now, leagues });
history = history.filter(entry => now - entry.ts <= RETENTION_MS);

writeFileSync(HISTORY_FILE, JSON.stringify(history));
const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`League snapshot recorded: ${leagues.length} leagues with roster detail in ${elapsedSec}s, ${history.length} snapshots retained.`);
