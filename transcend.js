'use strict';

const PALETTE = [
    '#6366f1', '#ec4899', '#10b981', '#f59e0b',
    '#ef4444', '#06b6d4', '#8b5cf6', '#f97316',
    '#14b8a6', '#a855f7', '#84cc16', '#3b82f6',
];

let historyData = [];
let playerSnapshots = [];
let state = { mode: 'top', searchResults: [], colorByUser: {}, nextColorIdx: 0 };
const DISPLAY_LIMIT = 1000;

function save() {
    try { localStorage.setItem('ps99_league_players_v1', JSON.stringify(state)); } catch (_) {}
}
function load() {
    try {
        const raw = localStorage.getItem('ps99_league_players_v1');
        if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch (_) {}
}

function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}
function fmt(n) { return (Number(n) || 0).toLocaleString(); }

function colorFor(userId) {
    const key = String(userId);
    if (!state.colorByUser[key]) {
        state.colorByUser[key] = PALETTE[state.nextColorIdx % PALETTE.length];
        state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;
    }
    return state.colorByUser[key];
}

function extractPlayers(snapshot) {
    const playerMap = new Map();
    for (const league of (snapshot.leagues || [])) {
        for (const p of (league.roster || [])) {
            const existing = playerMap.get(p.UserID);
            if (!existing || p.Points > existing.Points) {
                playerMap.set(p.UserID, {
                    UserID: p.UserID,
                    DisplayName: p.DisplayName,
                    Points: p.Points,
                    Clan: league.Name,
                });
            }
        }
    }
    const sorted = [...playerMap.values()].sort((a, b) => b.Points - a.Points);
    return { list: sorted, byId: playerMap };
}

function latestPlayerSnapshot() { return playerSnapshots.length ? playerSnapshots[playerSnapshots.length - 1] : null; }
function allPlayers() { return latestPlayerSnapshot()?.players?.list || []; }
function topPlayers() { return allPlayers().slice(0, DISPLAY_LIMIT); }
function displayedPlayers() { return state.mode === 'search' ? state.searchResults : topPlayers(); }

let toastTimer = null;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function findSnapshotNear(msAgo, toleranceMs) {
    if (playerSnapshots.length < 2) return null;
    const latest = playerSnapshots[playerSnapshots.length - 1];
    const targetTs = latest.ts - msAgo;
    const minAgeMs = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of playerSnapshots) {
        if (entry === latest) continue;
        if (latest.ts - entry.ts < minAgeMs) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

function playerDelta(userId, currentPoints, windowMs, toleranceMs) {
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) return { text: '—', color: '', value: null };
    const pastEntry = snap.players?.byId?.get(userId);
    if (!pastEntry) return { text: '—', color: '', value: null };
    const delta = currentPoints - pastEntry.Points;
    const sign = delta >= 0 ? '+' : '−';
    return {
        text: `${sign}${fmt(Math.abs(delta))}`,
        color: delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : 'var(--text-muted)'),
        value: delta,
    };
}

function renderSummaryStats() {
    const players = allPlayers();
    document.getElementById('ss-total').textContent = fmt(players.length);
    document.getElementById('ss-snapshots').textContent = playerSnapshots.length;

    const windows = [
        { id: 'ss-zero-10m', ms: 10 * 60_000, tol: 11 * 60_000 },
        { id: 'ss-zero-30m', ms: 30 * 60_000, tol: 8  * 60_000 },
        { id: 'ss-zero-1h',  ms: 60 * 60_000, tol: 12 * 60_000 },
    ];
    for (const w of windows) {
        const snap = findSnapshotNear(w.ms, w.tol);
        const el = document.getElementById(w.id);
        if (!snap) { el.textContent = '—'; continue; }
        const pastMap = snap.players?.byId;
        if (!pastMap) { el.textContent = '—'; continue; }
        let zeroCount = 0;
        for (const p of players) {
            const pastEntry = pastMap.get(p.UserID);
            if (pastEntry && p.Points - pastEntry.Points === 0) zeroCount++;
        }
        el.textContent = fmt(zeroCount);
    }
}

function showLeaderboard() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('leaderboard-view').classList.add('active');
    renderLeaderboard();
}

function showPlayerDetail(userId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('player-detail-view').classList.add('active');
    renderPlayerDetail(userId);
}

function renderLeaderboard() {
    renderSummaryStats();

    const badge = document.getElementById('event-status-badge');
    const snap = latestPlayerSnapshot();
    badge.innerHTML = snap
        ? `<span class="status-pill status-active">⚡ Updated ${new Date(snap.ts).toLocaleTimeString()}</span>`
        : '';

    const list = displayedPlayers();
    document.getElementById('leaderboard-heading').textContent =
        state.mode === 'search'
            ? `Search Results (${list.length} match${list.length === 1 ? '' : 'es'})`
            : `Top Players (${topPlayers().length})`;

    document.getElementById('clear-search-btn').style.display = state.mode === 'search' ? 'inline-block' : 'none';

    const tbody = document.getElementById('leaderboard-tbody');
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">
          ${state.mode === 'search' ? 'No players matched your search.' : 'No data yet — waiting for first snapshot.'}
        </td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((p, idx) => {
        const color = colorFor(p.UserID);
        const d10 = playerDelta(p.UserID, p.Points, 10 * 60_000, 11 * 60_000);
        const d30 = playerDelta(p.UserID, p.Points, 30 * 60_000, 8  * 60_000);
        const d1h = playerDelta(p.UserID, p.Points, 60 * 60_000, 12 * 60_000);
        return `
      <tr onclick="showPlayerDetail(${p.UserID})" style="cursor:pointer">
        <td class="player-rank">${idx + 1}</td>
        <td class="player-name"><span class="st-team-dot" style="background:${color}"></span> ${esc(p.DisplayName)}</td>
        <td style="font-size:12px;color:var(--text-secondary)">${esc(p.Clan || '—')}</td>
        <td class="player-points" style="color:${color}">${fmt(p.Points)}</td>
        <td style="color:${d10.color};font-size:12px">${d10.text}</td>
        <td style="color:${d30.color};font-size:12px">${d30.text}</td>
        <td style="color:${d1h.color};font-size:12px">${d1h.text}</td>
      </tr>`;
    }).join('');
}

function renderPlayerDetail(userId) {
    const players = allPlayers();
    const player = players.find(p => p.UserID === userId);
    if (!player) {
        toast('Player not found in current snapshot', 'error');
        showLeaderboard();
        return;
    }

    const color = colorFor(userId);
    const rank = players.indexOf(player) + 1;

    document.getElementById('player-detail-color-bar').style.background = color;
    document.getElementById('player-detail-name').textContent = player.DisplayName;
    document.getElementById('player-detail-sub').textContent = `User ID: ${player.UserID}`;
    document.getElementById('pd-rank').textContent = `#${fmt(rank)}`;
    document.getElementById('pd-pts').textContent = fmt(player.Points);
    document.getElementById('pd-league').textContent = player.Clan || '—';

    const d10 = playerDelta(userId, player.Points, 10 * 60_000, 11 * 60_000);
    const d30 = playerDelta(userId, player.Points, 30 * 60_000, 8  * 60_000);
    const d1h = playerDelta(userId, player.Points, 60 * 60_000, 12 * 60_000);

    const el10 = document.getElementById('pd-delta-10m');
    const el30 = document.getElementById('pd-delta-30m');
    const el1h = document.getElementById('pd-delta-1h');
    el10.textContent = d10.text; el10.style.color = d10.color;
    el30.textContent = d30.text; el30.style.color = d30.color;
    el1h.textContent = d1h.text; el1h.style.color = d1h.color;

    const tbody = document.getElementById('history-tbody');
    const rows = [];
    for (let i = playerSnapshots.length - 1; i >= 0; i--) {
        const snap = playerSnapshots[i];
        const entry = snap.players?.byId?.get(userId);
        if (!entry) continue;
        const prev = i > 0 ? playerSnapshots[i - 1].players?.byId?.get(userId) : null;
        const change = prev ? entry.Points - prev.Points : null;
        rows.push({ ts: snap.ts, points: entry.Points, change });
    }

    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:32px;color:var(--text-muted)">No history available.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(r => {
        const changeText = r.change === null ? '—'
            : r.change === 0 ? '+0'
            : (r.change > 0 ? `+${fmt(r.change)}` : `−${fmt(Math.abs(r.change))}`);
        const changeColor = r.change === null ? '' : (r.change > 0 ? 'var(--success)' : (r.change < 0 ? 'var(--danger)' : 'var(--text-muted)'));
        return `
          <tr>
            <td style="font-size:12px">${new Date(r.ts).toLocaleTimeString()}</td>
            <td class="player-points">${fmt(r.points)}</td>
            <td style="color:${changeColor};font-weight:600">${changeText}</td>
          </tr>`;
    }).join('');
}

const API_BASE = 'https://ps99.biggamesapi.io/v1';
const CORS_PROXIES = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
];

async function apiFetch(path) {
    const url = `${API_BASE}${path}`;
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
    return null;
}

async function resolveUsernameToId(username) {
    const ROBLOX_URL = 'https://users.roblox.com/v1/usernames/users';
    const body = JSON.stringify({ usernames: [username], excludeBannedUsers: false });
    const headers = { 'Content-Type': 'application/json' };
    try {
        const res = await fetch(ROBLOX_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
        if (res.ok) { const json = await res.json(); return json.data?.[0] || null; }
    } catch (_) {}
    for (const proxy of CORS_PROXIES) {
        try {
            const res = await fetch(`${proxy}${encodeURIComponent(ROBLOX_URL)}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(12000) });
            if (res.ok) { const json = await res.json(); return json.data?.[0] || null; }
        } catch (_) {}
    }
    return null;
}

async function searchPlayers() {
    const input = document.getElementById('search-player-name');
    const query = (input?.value || '').trim();
    if (!query) { toast('Enter a player name', 'error'); return; }

    const btn = document.getElementById('search-player-btn');
    const statusEl = document.getElementById('search-status');
    btn.disabled = true;
    statusEl.className = 'import-status loading';
    statusEl.innerHTML = '<span class="spinner"></span>Searching...';

    const localPlayers = allPlayers();
    const queryLower = query.toLowerCase();
    const localMatches = localPlayers.filter(p =>
        p.DisplayName.toLowerCase().includes(queryLower) || String(p.UserID) === query
    );

    if (localMatches.length) {
        state.searchResults = localMatches;
        state.mode = 'search';
        save();
        renderLeaderboard();
        statusEl.className = 'import-status success';
        statusEl.textContent = `Found ${localMatches.length} player(s).`;
        btn.disabled = false;
        return;
    }

    let userId = Number(query) || null;
    if (!userId) {
        const robloxUser = await resolveUsernameToId(query);
        if (robloxUser) {
            userId = robloxUser.id;
            const matchById = localPlayers.filter(p => p.UserID === userId);
            if (matchById.length) {
                state.searchResults = matchById;
                state.mode = 'search';
                save();
                renderLeaderboard();
                statusEl.className = 'import-status success';
                statusEl.textContent = `Found ${matchById.length} player(s) (resolved from "${query}").`;
                btn.disabled = false;
                return;
            }
        }
    }

    if (userId) {
        const res = await apiFetch(`/leagues/players/${userId}`);
        if (res?.data) {
            const p = res.data;
            const livePlayer = {
                UserID: p.UserID,
                DisplayName: p.DisplayName || String(p.UserID),
                Points: p.Points || 0,
                Clan: p.League || p.LeagueName || '—',
            };
            state.searchResults = [livePlayer];
            state.mode = 'search';
            save();
            renderLeaderboard();
            statusEl.className = 'import-status success';
            statusEl.textContent = `Found via live API: ${livePlayer.DisplayName} (${fmt(livePlayer.Points)} pts)`;
            btn.disabled = false;
            return;
        }
    }

    state.searchResults = [];
    state.mode = 'search';
    save();
    renderLeaderboard();
    statusEl.className = 'import-status error';
    statusEl.textContent = `No players found matching "${query}".`;
    btn.disabled = false;
}

function clearSearch() {
    document.getElementById('search-player-name').value = '';
    document.getElementById('search-status').innerHTML = '';
    if (state.mode === 'search') { state.mode = 'top'; save(); renderLeaderboard(); }
}

async function loadHistory() {
    const res = await fetch(`league_history.json?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) {
        const raw = await res.json();
        historyData = raw;
        playerSnapshots = raw.map(snap => ({
            ts: snap.ts,
            players: extractPlayers(snap),
        }));
    }
}

async function refreshAll({ silent = false } = {}) {
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }
    try {
        await loadHistory();
        renderLeaderboard();
        if (!silent) toast(`Loaded ${fmt(allPlayers().length)} players`, 'success');
    } catch (err) {
        if (!silent) toast(err.message || 'Failed to refresh', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }
}

document.getElementById('player-back-btn').addEventListener('click', showLeaderboard);
document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ silent: false }));
document.getElementById('search-player-btn').addEventListener('click', searchPlayers);
document.getElementById('clear-search-btn').addEventListener('click', clearSearch);
document.getElementById('search-player-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchPlayers(); }
});

setInterval(() => refreshAll({ silent: true }), 10 * 60_000);

load();
renderLeaderboard();
refreshAll({ silent: false });
