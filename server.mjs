import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const base = dirname(fileURLToPath(import.meta.url));
loadEnv(join(base, '.env'));
const port = Number(process.env.PORT || 4174);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
const cache = new Map();
const ttlMs = 8 * 60 * 1000;
const historyCache = new Map();
const historyTtlMs = 12 * 60 * 60 * 1000;
const lineHistoryPath = join(base, 'line-history.json');
const lineHistory = new Map();
let lineHistoryReady;
const lineHistoryRetentionMs = 30 * 24 * 60 * 60 * 1000;

async function loadLineHistory() {
  if (!lineHistoryReady) lineHistoryReady = (async () => {
    try {
      const stored = JSON.parse(await readFile(lineHistoryPath, 'utf8'));
      for (const [key, points] of Object.entries(stored)) if (Array.isArray(points)) lineHistory.set(key, points.filter(p => Date.now() - Date.parse(p.at) <= lineHistoryRetentionMs).slice(-500));
    } catch {}
  })();
  await lineHistoryReady;
}
let lineHistoryWrite = Promise.resolve();
const alertWatches = new Map();
const alertWatchPath = join(base, 'alert-watches.json');
let alertWatchReady;
async function loadAlertWatches() {
  if (!alertWatchReady) alertWatchReady = (async () => {
    try { const stored = JSON.parse(await readFile(alertWatchPath, 'utf8')); for (const [id, rule] of Object.entries(stored)) if (rule && typeof rule.key === 'string') alertWatches.set(id, rule); } catch {}
  })();
  await alertWatchReady;
}
let alertWatchWrite = Promise.resolve();
function persistAlertWatches() {
  alertWatchWrite = alertWatchWrite.then(() => writeFile(alertWatchPath, JSON.stringify(Object.fromEntries(alertWatches)), 'utf8')).catch(error => console.warn(`Could not persist alert watches: ${error.message}`));
  return alertWatchWrite;
}
function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { text += chunk; if (text.length > 64 * 1024) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}
function persistLineHistory() {
  lineHistoryWrite = lineHistoryWrite.then(async () => {
    await mkdir(base, { recursive: true });
    const stored = Object.fromEntries([...lineHistory].map(([key, points]) => [key, points.filter(p => Date.now() - Date.parse(p.at) <= lineHistoryRetentionMs).slice(-500)]));
    await writeFile(lineHistoryPath, JSON.stringify(stored), 'utf8');
  }).catch(error => console.warn(`Could not persist line history: ${error.message}`));
  return lineHistoryWrite;
}
function lineHistoryKey(eventId, playerId, stat, side) { return [eventId, playerId, stat, side].map(x => String(x || '').replaceAll('|', '_')).join('|'); }
function captureLineHistory(events, at) {
  let changed = false;
  for (const event of events) {
    const seen = new Set();
    for (const prop of event.props || []) {
      const key = lineHistoryKey(event.id, prop.playerId, prop.stat, prop.side);
      if (seen.has(key)) continue;
      seen.add(key);
      const points = lineHistory.get(key) || [];
      const previous = points.at(-1);
      if (previous && Date.now() - Date.parse(previous.at) < 4 * 60 * 1000) continue;
      points.push({ at, eventId: event.id, playerId: prop.playerId, player: prop.player, stat: prop.stat, side: prop.side, line: Number(prop.line), price: prop.price || null, bookmaker: prop.bookmaker || null });
      lineHistory.set(key, points.filter(p => Date.now() - Date.parse(p.at) <= lineHistoryRetentionMs).slice(-500));
      changed = true;
    }
  }
  return changed;
}
function getLineHistory(events) {
  const result = {};
  for (const event of events) for (const prop of event.props || []) {
    const key = lineHistoryKey(event.id, prop.playerId, prop.stat, prop.side);
    result[key] = lineHistory.get(key) || [];
  }
  return result;
}
async function checkAlertWatches(events, at) {
  await loadAlertWatches();
  const current = new Map();
  for (const event of events) for (const prop of event.props || []) {
    const key = lineHistoryKey(event.id, prop.playerId, prop.stat, prop.side);
    current.set(key, { ...prop, eventId: event.id, event: `${event.away} @ ${event.home}` });
  }
  const alerts = [];
  for (const [id, rule] of alertWatches) {
    const prop = current.get(rule.key);
    if (!prop) continue;
    const points = lineHistory.get(rule.key) || [];
    if (points.length < 2) continue;
    const previous = points.at(-2), latest = points.at(-1);
    if (!previous || !latest || latest.at !== at) continue;
    const move = Number(latest.line) - Number(previous.line);
    const favorable = rule.side.toLowerCase() === 'over' ? move < 0 : move > 0;
    const oldPrice = impliedProbability(previous.price), newPrice = impliedProbability(latest.price);
    const priceImproved = oldPrice !== null && newPrice !== null && oldPrice - newPrice >= Number(rule.priceThreshold || 0.025);
    const lineImproved = favorable && Math.abs(move) >= Number(rule.threshold || 0.5);
    if (lineImproved || priceImproved) alerts.push({ id, player: rule.player, stat: rule.stat, side: rule.side, event: prop.event, from: previous.line, to: latest.line, reason: priceImproved ? 'Price improved' : 'Line moved favorably', at: latest.at });
  }
  return alerts;
}

function loadEnv(path) {
  return readFile(path, 'utf8').then(text => {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }).catch(() => {});
}

function dateInET(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function marketLabel(statID, periodID) {
  const period = { game: '', reg: '', '1h': '1st Half', '2h': '2nd Half', '1q': '1st Quarter', '2q': '2nd Quarter', '3q': '3rd Quarter', '4q': '4th Quarter' }[periodID] ?? '';
  const stat = String(statID || 'Player prop').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').split('+').map(x => x.trim()).filter(Boolean).map(x => x.replace(/\b\w/g, c => c.toUpperCase())).join(' + ');
  return [period, stat].filter(Boolean).join(' ');
}
function impliedProbability(price) {
  const n = Number(String(price || '').replace('+', ''));
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}
function fairTwoWay(over, under) {
  const o = impliedProbability(over), u = impliedProbability(under), total = o !== null && u !== null ? o + u : 0;
  return total > 0 ? { over: o / total, under: u / total } : { over: null, under: null };
}
function marketSnapshot(event) {
  const odds = Object.values(event.odds || {});
  const find = (entity, betTypeID) => odds.find(o => o.statEntityID === entity && o.betTypeID === betTypeID && ['game', 'reg'].includes(o.periodID) && o.fairOddsAvailable !== false);
  const home = find('home', 'ml'), away = find('away', 'ml');
  const homeSpread = find('home', 'sp');
  const total = odds.find(o => o.statEntityID === 'all' && o.betTypeID === 'ou' && ['game', 'reg'].includes(o.periodID) && o.sideID === 'over');
  const hp = impliedProbability(home?.fairOdds || home?.bookOdds), ap = impliedProbability(away?.fairOdds || away?.bookOdds);
  const sum = hp && ap ? hp + ap : 0;
  return {
    homePrice: home?.bookOdds || home?.fairOdds || null,
    awayPrice: away?.bookOdds || away?.fairOdds || null,
    homeWinPct: sum ? Math.round(hp / sum * 100) : null,
    awayWinPct: sum ? Math.round(ap / sum * 100) : null,
    homeSpread: homeSpread?.bookSpread ?? homeSpread?.fairSpread ?? null,
    total: total?.bookOverUnder ?? total?.fairOverUnder ?? null
  };
}
function normalizeEvent(event) {
  const players = event.players || {};
  const availability = Object.fromEntries(Object.entries(players).map(([id, player]) => {
    const status = player?.status ?? event.player?.[id]?.status ?? null;
    const details = player?.statusDetails ?? player?.statusDetail ?? event.player?.[id]?.statusDetails ?? null;
    return [id, { status: status && typeof status === 'object' ? status.status ?? null : status, details: details && typeof details === 'object' ? details.description ?? details.detail ?? null : details }];
  }));
  const props = Object.values(event.odds || {}).filter(o => (o.playerID || (o.statEntityID && !['all', 'home', 'away'].includes(o.statEntityID))) && !['ml', 'sp'].includes(o.betTypeID) && ['ou', 'yn'].includes(o.betTypeID));
  const lines = props.flatMap(o => {
    const pid = o.playerID || o.statEntityID;
    const name = players[pid]?.names?.long || players[pid]?.name || pid.replace(/_[A-Z0-9]+$/i, '').replaceAll('_', ' ');
    const byLine = new Map();
    const twoWay = fairTwoWay(o.fairOverOdds || o.fairOddsOver, o.fairUnderOdds || o.fairOddsUnder);
    for (const [book, quote] of Object.entries(o.byBookmaker || {})) {
      if (quote.available === false) continue;
      const add = (line, price, updatedAt) => {
        const numericLine = Number(line);
        if (!Number.isFinite(numericLine)) return;
        const row = byLine.get(numericLine) || { line: numericLine, prices: [], books: new Set(), updates: [] };
        if (price) row.prices.push({ book, price });
        row.books.add(book);
        if (updatedAt) row.updates.push(updatedAt);
        byLine.set(numericLine, row);
      };
      add(quote.overUnder ?? quote.spread, quote.odds, quote.lastUpdatedAt);
      for (const alt of quote.altLines || []) add(alt.overUnder ?? alt.spread, alt.odds, alt.lastUpdatedAt || quote.lastUpdatedAt);
    }
    if (!byLine.size) {
      const line = Number(o.fairOverUnder ?? o.bookOverUnder ?? o.fairSpread ?? o.bookSpread);
      if (Number.isFinite(line)) byLine.set(line, { line, prices: [{ book: 'Consensus', price: o.fairOdds || o.bookOdds }].filter(x => x.price), books: new Set(), updates: [] });
    }
    return [...byLine.values()].map(row => {
      const fairPrice = o.fairOdds || o.bookOdds || '';
      const anchorLine = Number(o.fairOverUnder ?? o.bookOverUnder ?? o.fairSpread ?? o.bookSpread);
      const best = row.prices.sort((a, b) => {
        const decimal = value => { const n = Number(String(value).replace('+', '')); return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n); };
        return decimal(b.price) - decimal(a.price);
      })[0];
      return {
      player: name,
      playerId: pid,
      stat: marketLabel(o.statID, o.periodID),
      side: o.sideID || '',
      line: row.line,
      price: best?.price || fairPrice,
      bookmaker: best?.book || 'Consensus',
      fairOdds: fairPrice,
      fairProbability: Number.isFinite(anchorLine) && anchorLine === row.line ? (o.sideID === 'over' ? twoWay.over : o.sideID === 'under' ? twoWay.under : null) : null,
      books: row.books.size,
      bookQuotes: row.prices.map(x => ({ book: x.book, price: x.price })),
      lastUpdatedAt: row.updates.sort().at(-1) || null
    };
    });
  });
  return {
    id: event.eventID,
    away: event.teams?.away?.names?.medium || event.teams?.away?.names?.long || 'Away',
    home: event.teams?.home?.names?.medium || event.teams?.home?.names?.long || 'Home',
    startsAt: event.status?.startsAt,
    status: event.status?.displayLong || (event.status?.live ? 'Live' : 'Scheduled'),
    playerAvailability: availability,
    market: marketSnapshot(event),
    props: lines
  };
}

function numericResult(value) {
  const raw = value && typeof value === 'object' ? value.score ?? value.value ?? value.statValue : value;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const injuryCache = new Map();
function pdfTextTokens(buffer) {
  const parts = [];
  for (const match of buffer.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const bytes = Buffer.from(match[1], 'latin1');
    let stream;
    try { stream = zlib.inflateSync(bytes).toString('latin1'); } catch { stream = match[1]; }
    const decode = value => value.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? c)).replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    for (const m of stream.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) parts.push(decode(m[1]));
    for (const m of stream.matchAll(/\[((?:.|\n|\r)*?)\]\s*TJ/g)) for (const t of m[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) parts.push(decode(t[1]));
  }
  return parts.map(x => x.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim()).filter(Boolean);
}
function parseInjuryPdf(buffer) {
  const tokens = pdfTextTokens(buffer), players = [], statuses = new Set(['Out', 'Doubtful', 'Questionable', 'Probable', 'Available', 'Game Time Decision']);
  let game = '';
  for (let i = 0; i < tokens.length; i++) {
    const matchup = tokens[i].match(/^([A-Z]{2,3})@([A-Z]{2,3})$/);
    if (matchup) game = `${matchup[1]} @ ${matchup[2]}`;
    if (!statuses.has(tokens[i])) {
      continue;
    }
    let firstAt = -1;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) if (tokens[j].endsWith(',')) { firstAt = j + 1; break; }
    if (firstAt < 1 || !tokens[firstAt - 1]) continue;
    const name = `${tokens[firstAt]} ${tokens[firstAt - 1].slice(0, -1)}`;
    const reasonParts = [];
    for (let j = i + 1; j < tokens.length && j <= i + 8 && !statuses.has(tokens[j]) && !tokens[j].endsWith(','); j++) {
      if (tokens[j] !== '-') reasonParts.push(tokens[j]);
      if (reasonParts.length >= 4) break;
    }
    players.push({ name, status: tokens[i], reason: reasonParts.join(' '), game });
  }
  return [...new Map(players.map(p => [`${p.name.toLowerCase()}|${p.game}`, p])).values()];
}
function normalizePersonName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(jr|sr|ii|iii|iv)\.?$/i, '').replace(/[^a-z]/gi, '').toLowerCase();
}
async function officialInjuryReport(date) {
  const cached = injuryCache.get(date);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
  const [year, month] = date.split('-').map(Number), seasonStart = month >= 10 ? year : year - 1;
  const slug = `${seasonStart}-${String((seasonStart + 1) % 100).padStart(2, '0')}`;
  try {
    const page = await fetch(`https://official.nba.com/nba-injury-report-${slug}-season/`, { signal: AbortSignal.timeout(12000) });
    if (!page.ok) throw new Error(`NBA report page returned ${page.status}`);
    const html = await page.text();
    const links = [...html.matchAll(/https?:[^"'\s<>]+\.pdf[^"'\s<>]*/gi)].map(m => m[0].replaceAll('&amp;', '&')).filter(u => u.includes(`Injury-Report_${date}_`));
    const reports = links.map(url => {
      const m = url.match(/_(\d{1,2})_(\d{2})(AM|PM)\.pdf/i); if (!m) return null;
      let hour = Number(m[1]) % 12; if (m[3].toUpperCase() === 'PM') hour += 12;
      return { url, minute: hour * 60 + Number(m[2]), time: `${m[1]}:${m[2]} ${m[3].toUpperCase()}` };
    }).filter(Boolean);
    if (!reports.length) {
      const value = { date, source: 'NBA Official Injury Report', updatedAt: null, reportUrl: null, players: [], error: 'No report is published for this date yet' };
      injuryCache.set(date, { at: Date.now(), value }); return value;
    }
    const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const nowParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
    const nowMinute = Number(nowParts.find(x => x.type === 'hour').value) * 60 + Number(nowParts.find(x => x.type === 'minute').value);
    const chosen = reports.filter(x => date !== etDate || x.minute <= nowMinute).sort((a, b) => b.minute - a.minute)[0] || reports[0];
    const pdf = await fetch(chosen.url, { signal: AbortSignal.timeout(12000) }); if (!pdf.ok) throw new Error(`NBA report PDF returned ${pdf.status}`);
    const players = parseInjuryPdf(Buffer.from(await pdf.arrayBuffer()));
    const nameCoverage = players.filter(p => p.name && p.game).length;
    if (!nameCoverage) throw new Error('The official PDF text format was not recognized');
    const value = { date, source: 'NBA Official Injury Report', updatedAt: `${date} ${chosen.time} ET`, reportUrl: chosen.url, players };
    injuryCache.set(date, { at: Date.now(), value }); return value;
  } catch (error) {
    console.warn(`Official NBA availability unavailable for ${date}: ${error.message}`);
    return { date, source: 'NBA Official Injury Report', updatedAt: null, reportUrl: null, players: [], error: 'Official report unavailable' };
  }
}

async function recentPlayerStats(date, teams, key) {
  const cached = historyCache.get(date);
  if (cached && Date.now() - cached.at < historyTtlMs) return cached.players;
  if (!teams.length) return {};
  try {
    const end = new Date(`${date}T12:00:00Z`);
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - 14);
    const url = new URL('https://api.sportsgameodds.com/v2/events');
    url.search = new URLSearchParams({ leagueID: 'NBA', teamID: teams.join(','), finalized: 'true', ended: 'true', expandResults: 'true', startsAfter: start.toISOString(), startsBefore: end.toISOString(), limit: '100' });
    const response = await fetch(url, { headers: { 'X-Api-Key': key } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `History feed returned ${response.status}`);
    const players = {};
    for (const game of data.data || []) {
      const gameDate = game.status?.startsAt;
      if (!gameDate || dateInET(gameDate) >= date) continue;
      const periods = game.results || {};
      const full = periods.game || periods.reg || periods.full || {};
      const roster = game.players || {};
      for (const [id, statsObject] of Object.entries(full)) {
        // Event results also contain home/away team totals; keep only roster player IDs.
        if (!roster[id]) continue;
        const player = roster[id] || {};
        const stats = {};
        for (const [stat, value] of Object.entries(statsObject || {})) {
          const score = numericResult(value);
          if (score !== null) stats[stat] = score;
        }
        if (!Object.keys(stats).length) continue;
        const teamId = player.teamID;
        const opponent = game.teams?.home?.teamID === teamId
          ? game.teams?.away?.names?.medium || game.teams?.away?.names?.long
          : game.teams?.home?.names?.medium || game.teams?.home?.names?.long;
        (players[id] ||= []).push({
          date: gameDate,
          opponent: opponent || 'Opponent unavailable',
          homeAway: game.teams?.home?.teamID === teamId ? 'Home' : 'Away',
          minutesPlayed: stats.minutesPlayed ?? null,
          stats
        });
      }
    }
    for (const rows of Object.values(players)) rows.sort((a, b) => b.date.localeCompare(a.date));
    historyCache.set(date, { at: Date.now(), players });
    return players;
  } catch (error) {
    console.warn(`Recent player stats unavailable for ${date}: ${error.message}`);
    historyCache.set(date, { at: Date.now(), players: {} });
    return {};
  }
}

async function liveData(date) {
  const prior = cache.get(date);
  if (prior && Date.now() - prior.at < ttlMs) {
    await loadLineHistory();
    const fetchedAt = new Date().toISOString();
    const captured = captureLineHistory(prior.body.events, fetchedAt);
    if (captured) await persistLineHistory();
    const body = { ...prior.body, fetchedAt, lineHistory: getLineHistory(prior.body.events), alerts: captured ? await checkAlertWatches(prior.body.events, fetchedAt) : [], cached: true };
    return body;
  }
  const key = process.env.SPORTSGAMEODDS_API_KEY;
  if (!key) return { setupRequired: true, message: 'Add SPORTSGAMEODDS_API_KEY to outputs/.env to enable live data.' };
  const start = new Date(`${date}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(`${date}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 2);
  const url = new URL('https://api.sportsgameodds.com/v2/events');
  url.search = new URLSearchParams({ leagueID: 'NBA', oddsAvailable: 'true', includeAltLines: 'true', expandResults: 'true', startsAfter: start.toISOString(), startsBefore: end.toISOString(), limit: '100' });
  const response = await fetch(url, { headers: { 'X-Api-Key': key } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `SportsGameOdds returned ${response.status}`);
  const rawEvents = (data.data || []).filter(e => e.status?.startsAt && dateInET(e.status.startsAt) === date);
  const events = rawEvents.map(normalizeEvent);
  const teams = [...new Set(rawEvents.flatMap(e => [e.teams?.home?.teamID, e.teams?.away?.teamID]).filter(Boolean))];
  const playerStats = await recentPlayerStats(date, teams, key);
  const injuryReport = await officialInjuryReport(date);
  const body = { date, fetchedAt: new Date().toISOString(), events, playerStats, injuryReport, sources: { odds: 'SportsGameOdds', playerStats: Object.keys(playerStats).length ? 'SportsGameOdds event results · previous 14 days' : null, availability: injuryReport.error ? null : 'NBA Official Injury Report' }, source: 'SportsGameOdds + NBA Official Injury Report' };
  await loadLineHistory();
  const captured = captureLineHistory(events, body.fetchedAt);
  if (captured) await persistLineHistory();
  body.lineHistory = getLineHistory(events);
  body.alerts = captured ? await checkAlertWatches(events, body.fetchedAt) : [];
  body.sources.lineHistory = 'Server-captured SportsGameOdds snapshots · up to 30 days';
  cache.set(date, { at: Date.now(), body: { ...body, alerts: [] } });
  return body;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/live') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const date = url.searchParams.get('date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) { res.writeHead(400); return res.end(JSON.stringify({ message: 'Use a valid date=YYYY-MM-DD' })); }
      const body = await liveData(date);
      res.writeHead(body.setupRequired ? 503 : 200);
      return res.end(JSON.stringify(body));
    } catch (error) {
      res.writeHead(502); return res.end(JSON.stringify({ message: error.message }));
    }
  }
  if (url.pathname === '/api/line-history' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    await loadLineHistory();
    const key = url.searchParams.get('key') || '';
    const points = lineHistory.get(key) || [];
    return res.end(JSON.stringify({ key, points }));
  }
  if (url.pathname === '/api/alert-watches' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    await loadAlertWatches();
    return res.end(JSON.stringify({ watches: Object.fromEntries(alertWatches) }));
  }
  if (url.pathname === '/api/alert-watches' && req.method === 'PUT') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      await loadAlertWatches();
      const body = await jsonBody(req), id = String(body.id || '').slice(0, 180), rule = body.rule;
      if (!id) { res.writeHead(400); return res.end(JSON.stringify({ message: 'Watch id is required' })); }
      if (rule === null || rule?.active === false) alertWatches.delete(id);
      else if (rule && typeof rule === 'object' && typeof rule.key === 'string') alertWatches.set(id, { key: rule.key.slice(0, 500), player: String(rule.player || '').slice(0, 100), stat: String(rule.stat || '').slice(0, 100), side: String(rule.side || '').slice(0, 20), threshold: Math.max(0.5, Math.min(100, Number(rule.threshold) || 0.5)), priceThreshold: Math.max(0.005, Math.min(0.5, Number(rule.priceThreshold) || 0.025)), active: true, updatedAt: new Date().toISOString() });
      else { res.writeHead(400); return res.end(JSON.stringify({ message: 'A watch rule is required' })); }
      await persistAlertWatches();
      return res.end(JSON.stringify({ watches: Object.fromEntries(alertWatches) }));
    } catch (error) { res.writeHead(400); return res.end(JSON.stringify({ message: error.message })); }
  }
  if (url.pathname !== '/' && url.pathname !== '/index.html') { res.writeHead(404); return res.end('Not found'); }
  try {
    const page = await readFile(join(base, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
  } catch { res.writeHead(500); res.end('Could not load index.html'); }
});

await loadEnv(join(base, '.env'));
server.listen(port, () => console.log(`Sports props site running at http://localhost:${port}`));
