/* ═══════════════════════════════════════════
   PS99 Clan Battle — Pets vs Coins App Logic
   ═══════════════════════════════════════════ */

'use strict';

document.title = 'PS99 Clan Battle — Pets vs Coins [v4]';

// ── Constants ──────────────────────────────
const STORAGE_KEY  = 'ps99_clanbattle_v1';
const API_BASE     = 'https://ps99.biggamesapi.io/api';
const CORS_PROXIES = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
];

const PALETTE = [
    '#6366f1', '#ec4899', '#10b981', '#f59e0b',
    '#ef4444', '#06b6d4', '#8b5cf6', '#f97316',
    '#14b8a6', '#a855f7', '#84cc16', '#3b82f6',
];

// ── State ──────────────────────────────────
let historyData = [];

let state = {
    mode: 'top',
    searchResults: [],
    total: 0,
    colorByName: {},
    nextColorIdx: 0,
};

let ui = {
    currentClanName: null,
    currentClanDetail: null,
    currentRank: undefined,
    livePointsAsOf: undefined,
};

// ── Persistence ────────────────────────────
function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch (_) {}
}

// ── Helpers ────────────────────────────────
function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}

function fmt(n) {
    return (Number(n) || 0).toLocaleString();
}

function colorFor(name) {
    const key = name.toLowerCase();
    if (!state.colorByName[key]) {
        state.colorByName[key] = PALETTE[state.nextColorIdx % PALETTE.length];
        state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;
    }
    return state.colorByName[key];
}

function latestSnapshot() {
    return historyData.length ? historyData[historyData.length - 1] : null;
}

function topClans() {
    return latestSnapshot()?.clans || [];
}

function displayedClans() {
    return state.mode === 'search' ? state.searchResults : topClans();
}

// ── Toast ──────────────────────────────────
let toastTimer = null;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Navigation ─────────────────────────────
function showLeaderboard() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('leaderboard-view').classList.add('active');
    renderLeaderboard();
}

function showClanDetail(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('clan-detail-view').classList.add('active');
    ui.currentClanName = name;
    ui.currentClanDetail = null;
    ui.currentRank = undefined;
    ui.livePointsAsOf = undefined;
    renderClanDetail();
    openClanDetail(name);
}

function openClanDetail(name) {
    const nameLower = name.toLowerCase();
    const fromSnapshot = topClans().find(c => c.Name.toLowerCase() === nameLower);

    if (fromSnapshot) {
        ui.currentClanDetail = fromSnapshot;
        const idx = topClans().indexOf(fromSnapshot);
        if (idx !== -1) {
            ui.currentRank = idx + 1;
            renderClanDetail();
        } else {
            ui.currentRank = undefined;
            renderClanDetail();
        }
        refreshClanDetailLive(name);
        return;
    }
    fetchClanDetailLive(name);
}

// ── Leaderboard rendering ──────────────────
function renderLeaderboard() {
    const badge = document.getElementById('event-status-badge');
    const snap = latestSnapshot();
    badge.innerHTML = snap
        ? `<span class="status-pill status-active">⚡ Updated ${new Date(snap.ts).toLocaleTimeString()}</span>`
        : '';

    const list = displayedClans();
    document.getElementById('leaderboard-heading').textContent =
        state.mode === 'search'
            ? `Search Results (${state.total} match${state.total === 1 ? '' : 'es'})`
            : 'Top 100';

    document.getElementById('clear-search-btn').style.display = state.mode === 'search' ? 'inline-block' : 'none';

    const tbody = document.getElementById('leaderboard-tbody');
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:40px;color:var(--text-muted)">
          ${state.mode === 'search' ? 'No clans matched your search.' : 'No data yet — hit <strong>🔄 Refresh</strong> to load.'}
        </td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((c, idx) => {
        const color = colorFor(c.Name);
        const members = c.roster ? c.roster.length : (c.Members || 0);
        return `
      <tr onclick="showClanDetail('${esc(c.Name).replace(/'/g, "\\'")}')" style="cursor:pointer">
        <td class="player-rank">${idx + 1}</td>
        <td class="player-name"><span class="st-team-dot" style="background:${color}"></span> ${esc(c.Name)}</td>
        <td>${members}</td>
        <td class="player-points" style="color:${color}">${fmt(c.Points)}</td>
      </tr>`;
    }).join('');
}

// ── Clan Detail ────────────────────────────
function renderClanDetail() {
    const name = ui.currentClanName;
    const color = colorFor(name);
    document.getElementById('clan-detail-color-bar').style.background = color;
    document.getElementById('clan-detail-name').textContent = name;

    const rankEl = document.getElementById('cd-rank');
    if (ui.currentRank === undefined) {
        rankEl.textContent = 'Calculating…';
    } else if (ui.currentRank === null) {
        rankEl.textContent = 'Unknown';
    } else {
        rankEl.textContent = `#${fmt(ui.currentRank)}`;
    }

    const detail = ui.currentClanDetail;
    if (!detail) {
        document.getElementById('clan-detail-sub').textContent = 'Loading…';
        document.getElementById('cd-pts').textContent = '…';
        document.getElementById('cd-pts-asof').textContent = '';
        document.getElementById('cd-roster').textContent = '…';
        ['cd-delta-10m', 'cd-delta-30m', 'cd-delta-1h'].forEach(id => {
            document.getElementById(id).textContent = '—';
            document.getElementById(`${id}-asof`).textContent = '';
        });
        document.getElementById('roster-delta-note').textContent = '';
        document.getElementById('roster-tbody').innerHTML =
            `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Loading roster…</td></tr>`;
        return;
    }

    document.getElementById('clan-detail-sub').textContent = 'Clan Battle — Pets vs Coins';
    document.getElementById('cd-pts').textContent = fmt(detail.Points);
    const rosterCount = detail.roster ? detail.roster.length : 0;
    document.getElementById('cd-roster').textContent = `${rosterCount}`;
    document.getElementById('cd-pts-asof').textContent = ui.livePointsAsOf
        ? `🔴 Live as of ${new Date(ui.livePointsAsOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
        : (latestSnapshot() ? `Snapshot as of ${new Date(latestSnapshot().ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — refreshing…` : '');

    const snap10 = renderDeltaStat('cd-delta-10m', detail, 10 * 60_000, 11 * 60_000);
    const snap30 = renderDeltaStat('cd-delta-30m', detail, 30 * 60_000, 8  * 60_000);
    const snap1h = renderDeltaStat('cd-delta-1h',  detail, 60 * 60_000, 12 * 60_000);

    const noteParts = [
        snap10 && `Δ10m ${formatAsOf(snap10)}`,
        snap30 && `Δ30m ${formatAsOf(snap30)}`,
        snap1h && `Δ1Hr ${formatAsOf(snap1h)}`,
    ].filter(Boolean);
    document.getElementById('roster-delta-note').textContent = noteParts.length ? noteParts.join(' · ') : '';

    const tbody = document.getElementById('roster-tbody');
    const roster = detail.roster || [];
    tbody.innerHTML = roster.length
        ? roster.map((p, idx) => {
            const d10 = playerDelta(detail, p.UserID, p.Points, 10 * 60_000, 11 * 60_000);
            const d30 = playerDelta(detail, p.UserID, p.Points, 30 * 60_000, 8  * 60_000);
            const d1h = playerDelta(detail, p.UserID, p.Points, 60 * 60_000, 12 * 60_000);
            return `
              <tr>
                <td class="player-rank">${idx + 1}</td>
                <td class="player-name">${esc(p.DisplayName)}</td>
                <td class="player-points" style="color:${color}">${fmt(p.Points)}</td>
                <td style="color:${d10.color}">${d10.text}</td>
                <td style="color:${d30.color}">${d30.text}</td>
                <td style="color:${d1h.color}">${d1h.text}</td>
              </tr>`;
          }).join('')
        : `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">No roster data.</td></tr>`;
}

// ── Live PS99 API ──────────────────────────
async function apiFetch(url) {
    const isValid = d => d && typeof d === 'object' && d.status === 'ok';

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) { const d = await res.json(); if (isValid(d)) return d; }
    } catch (_) {}
    for (const proxy of CORS_PROXIES) {
        try {
            const res = await fetch(proxy + encodeURIComponent(url), { signal: AbortSignal.timeout(20000) });
            if (res.ok) { const d = await res.json(); if (isValid(d)) return d; }
        } catch (_) {}
    }
    throw new Error('API unavailable – check connection or try again later');
}

// ── Point-Delta History ────────────────────
async function loadHistory() {
    const res = await fetch(`history.json?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) historyData = await res.json();
}

function hasRosterData(entry) {
    return entry.clans.length === 0 || entry.clans[0].roster !== undefined;
}

function findSnapshotNear(msAgo, toleranceMs) {
    if (historyData.length < 2) return null;
    const latest = historyData[historyData.length - 1];
    const targetTs = latest.ts - msAgo;
    const minAgeMs = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of historyData) {
        if (entry === latest) continue;
        if (!hasRosterData(entry)) continue;
        if (latest.ts - entry.ts < minAgeMs) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

function findClanInSnapshot(snap, clanName) {
    return snap.clans.find(c => c.Name.toLowerCase() === clanName.toLowerCase());
}

function formatAsOf(snap) {
    return snap ? `as of ${new Date(snap.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
}

function renderDeltaStat(elId, detail, windowMs, toleranceMs) {
    const el = document.getElementById(elId);
    const asOfEl = document.getElementById(`${elId}-asof`);
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) {
        el.textContent = '—'; el.title = 'Not enough snapshot history yet';
        if (asOfEl) asOfEl.textContent = '';
        return null;
    }

    const entry = findClanInSnapshot(snap, detail.Name);
    if (!entry) {
        el.textContent = '—'; el.title = 'Clan was outside tracking at that time';
        if (asOfEl) asOfEl.textContent = '';
        return null;
    }

    const latest = latestSnapshot();
    const ageMin = Math.round((latest.ts - snap.ts) / 60000);
    const delta  = detail.Points - entry.Points;
    const sign   = delta >= 0 ? '+' : '−';
    el.textContent = `${sign}${fmt(Math.abs(delta))}`;
    el.title       = `From snapshot ${ageMin}m ago`;
    el.style.color = delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : '');
    if (asOfEl) asOfEl.textContent = `${ageMin}m ago`;
    return snap;
}

function playerDelta(detail, userId, currentPoints, windowMs, toleranceMs) {
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) return { text: '—', color: '' };

    const clan = findClanInSnapshot(snap, detail.Name);
    const past = clan?.roster?.find(p => p.UserID === userId)?.Points;
    if (past === undefined) return { text: '—', color: '' };

    const delta = currentPoints - past;
    const sign  = delta >= 0 ? '+' : '−';
    return {
        text: `${sign}${fmt(Math.abs(delta))}`,
        color: delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : ''),
    };
}

async function refreshAll({ silent = false } = {}) {
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }

    try {
        await loadHistory();
        if (state.mode === 'top') renderLeaderboard();
        if (ui.currentClanName) {
            const stillTracked = topClans().find(c => c.Name.toLowerCase() === ui.currentClanName.toLowerCase());
            if (stillTracked) {
                ui.currentClanDetail = stillTracked;
                const idx = topClans().indexOf(stillTracked);
                if (idx !== -1) {
                    ui.currentRank = idx + 1;
                    renderClanDetail();
                }
            }
        }
        if (!silent) toast(`Loaded ${fmt(topClans().length)} clans`, 'success');
    } catch (err) {
        if (!silent) toast(err.message || 'Failed to refresh', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }
}

async function searchClans() {
    const input = document.getElementById('search-clan-name');
    const query = (input?.value || '').trim();
    if (!query) { toast('Enter a clan name', 'error'); return; }

    const btn = document.getElementById('search-clan-btn');
    const setStatus = (msg, type = '') => {
        const el = document.getElementById('search-status');
        el.className = `import-status ${type}`;
        el.innerHTML = type === 'loading' ? `<span class="spinner"></span>${msg}` : msg;
    };

    btn.disabled = true;
    setStatus(`Searching for "${esc(query)}"…`, 'loading');

    try {
        const res = await apiFetch(`${API_BASE}/clan/${encodeURIComponent(query)}`);
        const clan = res.data;
        if (!clan) throw new Error('Clan not found');

        const detail = await buildLiveDetail(clan);
        state.searchResults = [detail];
        state.mode = 'search';
        state.total = 1;
        save();
        renderLeaderboard();
        setStatus(`✅ Found clan "${esc(detail.Name)}".`, 'success');
    } catch (err) {
        // Try searching the leaderboard pages for a partial match
        try {
            const queryLower = query.toLowerCase();
            const matches = topClans().filter(c => c.Name.toLowerCase().includes(queryLower));
            if (matches.length) {
                state.searchResults = matches;
                state.mode = 'search';
                state.total = matches.length;
                save();
                renderLeaderboard();
                setStatus(`✅ Found ${matches.length} clan(s) matching "${esc(query)}" in Top 100.`, 'success');
            } else {
                setStatus(`❌ Clan "${esc(query)}" not found.`, 'error');
            }
        } catch (_) {
            setStatus(`❌ ${err.message}`, 'error');
        }
    } finally {
        btn.disabled = false;
    }
}

function clearSearch() {
    document.getElementById('search-clan-name').value = '';
    document.getElementById('search-status').innerHTML = '';
    if (state.mode === 'search') {
        state.mode = 'top';
        renderLeaderboard();
    }
}

// ── Roblox username resolution ─────────────
async function resolveUsernames(userIds) {
    if (!userIds.length) return {};
    const map = {};
    const ROBLOX_URL = 'https://users.roblox.com/v1/users';

    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100).map(Number).filter(id => id > 0);
        if (!batch.length) continue;

        const body    = JSON.stringify({ userIds: batch, excludeBannedUsers: false });
        const headers = { 'Content-Type': 'application/json' };
        let parsed = null;

        try {
            const res = await fetch(ROBLOX_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
            if (res.ok) parsed = await res.json();
        } catch (_) {}
        for (const proxy of CORS_PROXIES) {
            if (parsed) break;
            try {
                const res = await fetch(`${proxy}${encodeURIComponent(ROBLOX_URL)}`, {
                    method: 'POST', headers, body, signal: AbortSignal.timeout(12000),
                });
                if (res.ok) parsed = await res.json();
            } catch (_) {}
        }

        if (parsed) {
            (parsed.data || []).forEach(u => {
                const display = u.displayName || u.name;
                map[u.id] = display;
                map[String(u.id)] = display;
            });
        }
    }
    return map;
}

function isUnresolvedName(entity) {
    return !!(entity && entity.UserID && entity.DisplayName === String(entity.UserID));
}

let resolvedNamesCachePromise = null;
function getResolvedNamesCache() {
    if (!resolvedNamesCachePromise) {
        resolvedNamesCachePromise = fetch(`resolved_names.json?t=${Date.now()}`)
            .then(res => (res.ok ? res.json() : {}))
            .catch(() => ({}));
    }
    return resolvedNamesCachePromise;
}

function firstDefined(...args) {
    for (const a of args) if (a !== undefined && a !== null) return a;
    return undefined;
}

function asNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

async function buildLiveDetail(raw) {
    const cache = await getResolvedNamesCache();

    const members = Array.isArray(raw.Members) ? raw.Members : [];
    const battles = raw.Battles || raw.battles || {};
    const battleKeys = Object.keys(battles);
    let battleData = battleKeys.length ? battles[battleKeys[battleKeys.length - 1]] : null;

    let contribRows = [];
    if (battleData) {
        contribRows = firstDefined(
            battleData.PointContributions, battleData.pointContributions,
            battleData.Contributions, battleData.contributions,
            battleData.Contribution, battleData.contribution
        ) || [];
        if (!Array.isArray(contribRows)) contribRows = [];
    }
    if (!contribRows.length) {
        const fb = firstDefined(
            raw.Contribution?.Battle, raw.contribution?.battle,
            raw.Contributions?.Battle, raw.contributions?.battle
        );
        if (Array.isArray(fb)) contribRows = fb;
    }

    const contribByUser = {};
    for (const c of contribRows) {
        const uid = asNumber(firstDefined(c.UserID, c.UserId, c.user_id, c.userId, c.id));
        const pts = asNumber(firstDefined(c.Points, c.points, c.TotalPoints, c.total_points, c.Score, c.score, c.Value, c.value));
        if (uid > 0) contribByUser[uid] = pts;
    }

    const roster = [];
    const seen = new Set();
    for (const m of members) {
        const uid = asNumber(firstDefined(m.UserID, m.UserId, m.user_id, m.userId, m.id));
        if (uid <= 0) continue;
        seen.add(uid);
        let displayName = String(uid);
        if (cache[uid]) displayName = cache[uid];
        else if (cache[String(uid)]) displayName = cache[String(uid)];
        roster.push({ UserID: uid, DisplayName: displayName, Points: contribByUser[uid] ?? 0 });
    }
    for (const [uidStr, pts] of Object.entries(contribByUser)) {
        const uid = Number(uidStr);
        if (!seen.has(uid) && uid > 0) {
            let displayName = String(uid);
            if (cache[uid]) displayName = cache[uid];
            else if (cache[uidStr]) displayName = cache[uidStr];
            roster.push({ UserID: uid, DisplayName: displayName, Points: pts });
        }
    }

    // Resolve any still-numeric display names
    const needsResolve = roster.filter(p => p.DisplayName === String(p.UserID)).map(p => p.UserID);
    if (needsResolve.length) {
        const resolved = await resolveUsernames([...new Set(needsResolve)]);
        roster.forEach(p => {
            if (p.DisplayName === String(p.UserID) && (resolved[p.UserID] || resolved[String(p.UserID)])) {
                p.DisplayName = resolved[p.UserID] || resolved[String(p.UserID)];
            }
        });
    }

    roster.sort((a, b) => b.Points - a.Points);

    const totalPoints = asNumber(firstDefined(raw.Points, raw.points));
    return {
        Name: raw.Name || raw.name || 'Unknown',
        Points: totalPoints || Object.values(contribByUser).reduce((s, v) => s + v, 0),
        Members: roster.length,
        roster,
    };
}

async function fetchClanDetailLive(name) {
    try {
        const res = await apiFetch(`${API_BASE}/clan/${encodeURIComponent(name)}`);
        const detail = await buildLiveDetail(res.data);

        ui.currentClanDetail = detail;
        if (ui.currentClanName === name) {
            ui.livePointsAsOf = Date.now();
            // Try to find rank in the top clans
            const idx = topClans().findIndex(c => c.Name.toLowerCase() === name.toLowerCase());
            ui.currentRank = idx !== -1 ? idx + 1 : null;
            renderClanDetail();
        }
    } catch (err) {
        toast(err.message, 'error');
        document.getElementById('clan-detail-sub').textContent = 'Failed to load clan detail.';
    }
}

async function refreshClanDetailLive(name) {
    try {
        const res = await apiFetch(`${API_BASE}/clan/${encodeURIComponent(name)}`);
        if (ui.currentClanName !== name) return;
        const detail = await buildLiveDetail(res.data);
        if (ui.currentClanName !== name) return;
        ui.currentClanDetail = detail;
        ui.livePointsAsOf = Date.now();
        renderClanDetail();
    } catch (_) {}
}

// ── Event Listeners ────────────────────────
document.getElementById('clan-back-btn').addEventListener('click', showLeaderboard);
document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ silent: false }));
document.getElementById('search-clan-btn').addEventListener('click', searchClans);
document.getElementById('clear-search-btn').addEventListener('click', clearSearch);
document.getElementById('search-clan-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchClans(); }
});

// ── Auto-Refresh ───────────────────────────
setInterval(() => refreshAll({ silent: true }), 10 * 60_000);

// ── Bootstrap ──────────────────────────────
load();
renderLeaderboard();
refreshAll({ silent: false });
