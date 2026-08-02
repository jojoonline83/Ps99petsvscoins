'use strict';

const API_BASE = 'https://ps99.biggamesapi.io/v1';
const CORS_PROXIES = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
];
const PALETTE = [
    '#6366f1', '#ec4899', '#10b981', '#f59e0b',
    '#ef4444', '#06b6d4', '#8b5cf6', '#f97316',
    '#14b8a6', '#a855f7', '#84cc16', '#3b82f6',
];

let historyData = [];
let state = { mode: 'top', searchResults: [], total: 0, colorByName: {}, nextColorIdx: 0 };
const DISPLAY_LIMIT = 1000;
let ui = { currentLeagueName: null, currentLeagueDetail: null, currentRank: undefined, livePointsAsOf: undefined };
let overallTotalCache = 0;

function save() {
    try { localStorage.setItem('ps99_league_cb_v1', JSON.stringify(state)); } catch (_) {}
}
function load() {
    try {
        const raw = localStorage.getItem('ps99_league_cb_v1');
        if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch (_) {}
}

function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}
function fmt(n) { return (Number(n) || 0).toLocaleString(); }

function colorFor(name) {
    const key = name.toLowerCase();
    if (!state.colorByName[key]) {
        state.colorByName[key] = PALETTE[state.nextColorIdx % PALETTE.length];
        state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;
    }
    return state.colorByName[key];
}

function latestSnapshot() { return historyData.length ? historyData[historyData.length - 1] : null; }
function topLeagues() { return latestSnapshot()?.leagues || []; }
function allLeagues() { return topLeagues().filter(l => !l.Extra); }
function rankedLeagues() { return allLeagues().slice(0, DISPLAY_LIMIT); }
function displayedLeagues() { return state.mode === 'search' ? state.searchResults : rankedLeagues(); }

let toastTimer = null;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function showLeaderboard() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('leaderboard-view').classList.add('active');
    renderLeaderboard();
}

function showLeagueDetail(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('league-detail-view').classList.add('active');
    ui.currentLeagueName = name;
    ui.currentLeagueDetail = null;
    ui.currentRank = undefined;
    ui.livePointsAsOf = undefined;
    renderLeagueDetail();
    openLeagueDetail(name);
}

function openLeagueDetail(name) {
    const nameLower = name.toLowerCase();
    const fromSnapshot = topLeagues().find(l => l.Name.toLowerCase() === nameLower);
    if (fromSnapshot) {
        ui.currentLeagueDetail = fromSnapshot;
        const rankedIdx = rankedLeagues().indexOf(fromSnapshot);
        if (rankedIdx !== -1) {
            ui.currentRank = rankedIdx + 1;
            renderLeagueDetail();
        } else {
            ui.currentRank = undefined;
            renderLeagueDetail();
            resolveRank(name, fromSnapshot);
        }
        refreshLeagueDetailLive(name);
        return;
    }
    fetchLeagueDetailLive(name);
}

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
    throw new Error('API unavailable');
}

async function loadHistory() {
    const res = await fetch(`league_history.json?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) historyData = await res.json();
}

function hasRosterData(entry) {
    return entry.leagues.length === 0 || entry.leagues[0].roster !== undefined;
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

function findLeagueInSnapshot(snap, leagueId, leagueName) {
    return snap.leagues.find(l => l.ID === leagueId || l.Name.toLowerCase() === leagueName.toLowerCase());
}

function leagueDelta(league, windowMs, toleranceMs) {
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) return { text: '—', color: '' };
    const past = findLeagueInSnapshot(snap, league.ID, league.Name);
    if (!past) return { text: '—', color: '' };
    const delta = league.Points - past.Points;
    const sign = delta >= 0 ? '+' : '−';
    return {
        text: `${sign}${fmt(Math.abs(delta))}`,
        color: delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : 'var(--text-muted)'),
    };
}

function formatAsOf(snap) {
    return snap ? `as of ${new Date(snap.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
}

function renderDeltaStat(elId, detail, windowMs, toleranceMs) {
    const el = document.getElementById(elId);
    const asOfEl = document.getElementById(`${elId}-asof`);
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) { el.textContent = '—'; if (asOfEl) asOfEl.textContent = ''; return null; }
    const entry = findLeagueInSnapshot(snap, detail.ID, detail.Name);
    if (!entry) { el.textContent = '—'; if (asOfEl) asOfEl.textContent = ''; return null; }
    const delta = detail.Points - entry.Points;
    const sign = delta >= 0 ? '+' : '−';
    el.textContent = `${sign}${fmt(Math.abs(delta))}`;
    el.style.color = delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : '');
    if (asOfEl) asOfEl.textContent = formatAsOf(snap);
    return snap;
}

function playerDelta(detail, userId, currentPoints, windowMs, toleranceMs) {
    if (historyData.length < 2) return { text: '—', color: '' };
    const latest = historyData[historyData.length - 1];
    const targetTs = latest.ts - windowMs;
    const minAgeMs = windowMs / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of historyData) {
        if (entry === latest) continue;
        if (latest.ts - entry.ts < minAgeMs) continue;
        const league = findLeagueInSnapshot(entry, detail.ID, detail.Name);
        if (!league?.roster?.find(p => p.UserID === userId)) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    if (!best || bestDiff > toleranceMs) return { text: '—', color: '' };
    const pastLeague = findLeagueInSnapshot(best, detail.ID, detail.Name);
    const past = pastLeague.roster.find(p => p.UserID === userId).Points;
    const delta = currentPoints - past;
    const sign = delta >= 0 ? '+' : '−';
    return {
        text: `${sign}${fmt(Math.abs(delta))}`,
        color: delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : ''),
    };
}

function renderLeaderboard() {
    const badge = document.getElementById('event-status-badge');
    const snap = latestSnapshot();
    badge.innerHTML = snap
        ? `<span class="status-pill status-active">⚡ Updated ${new Date(snap.ts).toLocaleTimeString()}</span>`
        : '';

    const list = displayedLeagues();
    document.getElementById('leaderboard-heading').textContent =
        state.mode === 'search'
            ? `Search Results (${state.total} match${state.total === 1 ? '' : 'es'})`
            : `Top Leagues (${rankedLeagues().length})`;

    document.getElementById('clear-search-btn').style.display = state.mode === 'search' ? 'inline-block' : 'none';

    const tbody = document.getElementById('leaderboard-tbody');
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">
          ${state.mode === 'search' ? 'No leagues matched your search.' : 'No data yet — waiting for first snapshot.'}
        </td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((l, idx) => {
        const color = colorFor(l.Name);
        const d10 = leagueDelta(l, 10 * 60_000, 15 * 60_000);
        const d30 = leagueDelta(l, 30 * 60_000, 15 * 60_000);
        const d1h = leagueDelta(l, 60 * 60_000, 20 * 60_000);
        return `
      <tr onclick="showLeagueDetail('${esc(l.Name).replace(/'/g, "\\'")}')" style="cursor:pointer">
        <td class="player-rank">${idx + 1}</td>
        <td class="player-name"><span class="st-team-dot" style="background:${color}"></span> ${esc(l.Name)}</td>
        <td>${l.Members}/${l.MemberCapacity}</td>
        <td class="player-points" style="color:${color}">${fmt(l.Points)}</td>
        <td style="color:${d10.color};font-size:12px">${d10.text}</td>
        <td style="color:${d30.color};font-size:12px">${d30.text}</td>
        <td style="color:${d1h.color};font-size:12px">${d1h.text}</td>
      </tr>`;
    }).join('');
}

function renderLeagueDetail() {
    const name = ui.currentLeagueName;
    const color = colorFor(name);
    document.getElementById('league-detail-color-bar').style.background = color;
    document.getElementById('league-detail-name').textContent = name;

    const rankEl = document.getElementById('ld-rank');
    if (ui.currentRank === undefined) rankEl.textContent = 'Calculating…';
    else if (ui.currentRank === null) rankEl.textContent = 'Unknown';
    else rankEl.textContent = `#${fmt(ui.currentRank)}${overallTotalCache ? ` of ${fmt(overallTotalCache)}` : ''}`;

    const detail = ui.currentLeagueDetail;
    if (!detail) {
        document.getElementById('league-detail-sub').textContent = 'Loading…';
        document.getElementById('ld-pts').textContent = '…';
        document.getElementById('ld-pts-asof').textContent = '';
        document.getElementById('ld-roster').textContent = '…';
        document.getElementById('ld-level').textContent = '…';
        ['ld-delta-10m', 'ld-delta-30m', 'ld-delta-1h'].forEach(id => {
            document.getElementById(id).textContent = '—';
            document.getElementById(`${id}-asof`).textContent = '';
        });
        document.getElementById('roster-delta-note').textContent = '';
        document.getElementById('roster-tbody').innerHTML =
            `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Loading roster…</td></tr>`;
        return;
    }

    document.getElementById('league-detail-sub').textContent = 'PS99 League';
    document.getElementById('ld-pts').textContent = fmt(detail.Points);
    document.getElementById('ld-roster').textContent = `${detail.roster.length}/${detail.MemberCapacity}`;
    document.getElementById('ld-level').textContent = detail.Level ?? '—';
    document.getElementById('ld-pts-asof').textContent = ui.livePointsAsOf
        ? `Live as of ${new Date(ui.livePointsAsOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
        : (latestSnapshot() ? `Snapshot as of ${new Date(latestSnapshot().ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '');

    const snap10 = renderDeltaStat('ld-delta-10m', detail, 10 * 60_000, 15 * 60_000);
    const snap30 = renderDeltaStat('ld-delta-30m', detail, 30 * 60_000, 15 * 60_000);
    const snap1h = renderDeltaStat('ld-delta-1h',  detail, 60 * 60_000, 20 * 60_000);

    const noteParts = [
        snap10 && `10m ${formatAsOf(snap10)}`,
        snap30 && `30m ${formatAsOf(snap30)}`,
        snap1h && `1h ${formatAsOf(snap1h)}`,
    ].filter(Boolean);
    document.getElementById('roster-delta-note').textContent = noteParts.length ? noteParts.join(' · ') : '';

    const roleLabel = r => r === 'Owner' ? 'Owner' : 'Member';
    const tbody = document.getElementById('roster-tbody');
    tbody.innerHTML = detail.roster.length
        ? detail.roster.map(p => {
            const d10 = playerDelta(detail, p.UserID, p.Points, 10 * 60_000, 15 * 60_000);
            const d30 = playerDelta(detail, p.UserID, p.Points, 30 * 60_000, 15 * 60_000);
            const d1h = playerDelta(detail, p.UserID, p.Points, 60 * 60_000, 20 * 60_000);
            return `
              <tr>
                <td>${roleLabel(p.Role)}</td>
                <td class="player-name">${esc(p.DisplayName)}</td>
                <td class="player-points" style="color:${color}">${fmt(p.Points)}</td>
                <td style="color:${d10.color}">${d10.text}</td>
                <td style="color:${d30.color}">${d30.text}</td>
                <td style="color:${d1h.color}">${d1h.text}</td>
              </tr>`;
          }).join('')
        : `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">No roster data.</td></tr>`;
}

function isUnresolvedName(entity) {
    return !!(entity && entity.UserID && entity.DisplayName === String(entity.UserID));
}

async function resolveUsernames(userIds) {
    if (!userIds.length) return {};
    const map = {};
    const ROBLOX_URL = 'https://users.roblox.com/v1/users';
    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100).map(Number).filter(id => id > 0);
        if (!batch.length) continue;
        const body = JSON.stringify({ userIds: batch, excludeBannedUsers: false });
        const headers = { 'Content-Type': 'application/json' };
        let parsed = null;
        try {
            const res = await fetch(ROBLOX_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
            if (res.ok) parsed = await res.json();
        } catch (_) {}
        for (const proxy of CORS_PROXIES) {
            if (parsed) break;
            try {
                const res = await fetch(`${proxy}${encodeURIComponent(ROBLOX_URL)}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(12000) });
                if (res.ok) parsed = await res.json();
            } catch (_) {}
        }
        if (parsed) {
            (parsed.data || []).forEach(u => { map[u.id] = u.displayName || u.name; });
        }
    }
    return map;
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

async function buildLiveDetail(raw) {
    const cache = await getResolvedNamesCache();
    const applyCached = entity => { if (isUnresolvedName(entity) && cache[entity.UserID]) entity.DisplayName = cache[entity.UserID]; };
    applyCached(raw.Owner);
    (raw.Members || []).forEach(applyCached);

    const needsResolve = [];
    if (isUnresolvedName(raw.Owner)) needsResolve.push(raw.Owner.UserID);
    (raw.Members || []).forEach(m => { if (isUnresolvedName(m)) needsResolve.push(m.UserID); });
    if (needsResolve.length) {
        const resolved = await resolveUsernames([...new Set(needsResolve)]);
        if (isUnresolvedName(raw.Owner) && resolved[raw.Owner.UserID]) raw.Owner.DisplayName = resolved[raw.Owner.UserID];
        (raw.Members || []).forEach(m => { if (isUnresolvedName(m) && resolved[m.UserID]) m.DisplayName = resolved[m.UserID]; });
    }

    const contribByUser = {};
    (raw.PointContributions || []).forEach(c => { contribByUser[c.UserID] = c.Points; });

    const roster = [];
    if (raw.Owner && raw.Owner.UserID) {
        roster.push({ UserID: raw.Owner.UserID, DisplayName: raw.Owner.DisplayName, Points: contribByUser[raw.Owner.UserID] ?? 0, Role: 'Owner' });
    }
    (raw.Members || []).forEach(m => {
        roster.push({ UserID: m.UserID, DisplayName: m.DisplayName, Points: contribByUser[m.UserID] ?? 0, Role: 'Member' });
    });

    return { ID: raw.ID, Name: raw.Name, Points: raw.Points, MemberCapacity: raw.MemberCapacity, Level: raw.Level, roster };
}

async function fetchLeagueDetailLive(name) {
    try {
        const res = await apiFetch(`/leagues/${encodeURIComponent(name)}`);
        const detail = await buildLiveDetail(res.data);
        ui.currentLeagueDetail = detail;
        if (ui.currentLeagueName === name) { ui.livePointsAsOf = Date.now(); renderLeagueDetail(); }
        resolveRank(name, detail);
    } catch (err) {
        toast(err.message, 'error');
        document.getElementById('league-detail-sub').textContent = 'Failed to load league detail.';
    }
}

async function refreshLeagueDetailLive(name) {
    try {
        const res = await apiFetch(`/leagues/${encodeURIComponent(name)}`);
        if (ui.currentLeagueName !== name) return;
        const detail = await buildLiveDetail(res.data);
        if (ui.currentLeagueName !== name) return;
        ui.currentLeagueDetail = detail;
        ui.livePointsAsOf = Date.now();
        renderLeagueDetail();
    } catch (_) {}
}

async function resolveRank(name, detail) {
    const nameLower = name.toLowerCase();
    try {
        const pageSize = 100;
        if (!overallTotalCache) {
            const totalRes = await apiFetch('/leagues?page=1&pageSize=1&sort=Points&sortOrder=desc');
            overallTotalCache = totalRes.data.total || 0;
        }
        const totalPages = Math.max(1, Math.ceil(overallTotalCache / pageSize));
        const targetPoints = detail.Points;
        const matches = l => l.NameLower === nameLower || l.Name.toLowerCase() === nameLower || l.ID === detail.ID;

        let lo = 1, hi = totalPages, rank = null;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const res = await apiFetch(`/leagues?page=${mid}&pageSize=${pageSize}&sort=Points&sortOrder=desc`);
            const pageLeagues = res.data.leagues || [];
            if (!pageLeagues.length) { hi = mid - 1; continue; }
            const idx = pageLeagues.findIndex(matches);
            if (idx !== -1) { rank = (mid - 1) * pageSize + idx + 1; break; }
            const firstPts = pageLeagues[0].Points;
            const lastPts = pageLeagues[pageLeagues.length - 1].Points;
            if (targetPoints > firstPts) hi = mid - 1;
            else if (targetPoints < lastPts) lo = mid + 1;
            else break;
        }
        ui.currentRank = rank;
    } catch (_) {
        ui.currentRank = null;
    }
    if (ui.currentLeagueName === name) renderLeagueDetail();
}

async function searchLeagues() {
    const input = document.getElementById('search-league-name');
    const query = (input?.value || '').trim();
    if (!query) { toast('Enter a league name', 'error'); return; }

    const btn = document.getElementById('search-league-btn');
    const setStatus = (msg, type = '') => {
        const el = document.getElementById('search-status');
        el.className = `import-status ${type}`;
        el.innerHTML = type === 'loading' ? `<span class="spinner"></span>${msg}` : msg;
    };

    btn.disabled = true;
    setStatus(`Searching for "${esc(query)}"…`, 'loading');

    try {
        const res = await apiFetch(`/leagues?search=${encodeURIComponent(query)}&page=1&pageSize=50&sort=Points&sortOrder=desc`);
        const leagues = res.data.leagues || [];
        state.searchResults = leagues;
        state.mode = 'search';
        state.total = res.data.total || leagues.length;
        save();
        renderLeaderboard();
        setStatus(leagues.length ? `Found ${state.total} matching league(s).` : `No leagues found matching "${esc(query)}".`, leagues.length ? 'success' : 'error');
    } catch (err) {
        setStatus(err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

function clearSearch() {
    document.getElementById('search-league-name').value = '';
    document.getElementById('search-status').innerHTML = '';
    if (state.mode === 'search') { state.mode = 'top'; save(); renderLeaderboard(); }
}

async function refreshAll({ silent = false } = {}) {
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }
    try {
        await loadHistory();
        if (state.mode === 'top') renderLeaderboard();
        if (ui.currentLeagueName) {
            const stillTracked = topLeagues().find(l => l.Name.toLowerCase() === ui.currentLeagueName.toLowerCase());
            if (stillTracked) {
                ui.currentLeagueDetail = stillTracked;
                const rankedIdx = rankedLeagues().indexOf(stillTracked);
                if (rankedIdx !== -1) { ui.currentRank = rankedIdx + 1; renderLeagueDetail(); }
            }
        }
        if (!silent) toast(`Loaded ${fmt(topLeagues().length)} leagues`, 'success');
    } catch (err) {
        if (!silent) toast(err.message || 'Failed to refresh', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }
}

document.getElementById('league-back-btn').addEventListener('click', showLeaderboard);
document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ silent: false }));
document.getElementById('search-league-btn').addEventListener('click', searchLeagues);
document.getElementById('clear-search-btn').addEventListener('click', clearSearch);
document.getElementById('search-league-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchLeagues(); }
});

setInterval(() => refreshAll({ silent: true }), 10 * 60_000);

load();
renderLeaderboard();
refreshAll({ silent: false });
