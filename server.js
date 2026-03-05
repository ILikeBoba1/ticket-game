const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_PATH = path.join(__dirname, 'data.json');
const DAILY_PLAY_LIMIT = 3;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const DAILY_TIMEZONE = process.env.DAILY_TIMEZONE || 'UTC';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PHASE_HISTORY_LIMIT = 200;
const PHASE_FINISH = 10;

const VALID_GAMES = new Set(['reaction', 'click', 'memory']);

const MAX_POINTS = {
  reaction: 500,
  click: 500,
  memory: 200
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function createDefaultData() {
  return {
    gameLocked: false,
    players: {},
    playTokens: {},
    phaseHistory: []
  };
}

function readData() {
  if (!fs.existsSync(DATA_PATH)) {
    const defaultData = createDefaultData();
    fs.writeFileSync(DATA_PATH, JSON.stringify(defaultData, null, 2), 'utf8');
    return defaultData;
  }

  const raw = fs.readFileSync(DATA_PATH, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(raw);

  data.gameLocked = Boolean(data.gameLocked);
  data.players = data.players || {};
  data.playTokens = data.playTokens || {};
  data.phaseHistory = Array.isArray(data.phaseHistory) ? data.phaseHistory : [];
  return data;
}

function writeData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function sanitizeName(name, maxLen = 40) {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, maxLen);
}

function sanitizePlayerName(name) {
  return sanitizeName(name, 40);
}

function sanitizeText(value, maxLen = 250) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function getTodayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return y + '-' + m + '-' + d;
}

function ensurePlayer(data, playerName) {
  if (!data.players[playerName]) {
    data.players[playerName] = {
      score: 0,
      playsByDate: {}
    };
  }

  if (!data.players[playerName].playsByDate) {
    data.players[playerName].playsByDate = {};
  }

  return data.players[playerName];
}

function ensureDateBucket(player, dateKey) {
  if (!player.playsByDate[dateKey]) {
    player.playsByDate[dateKey] = {
      reaction: 0,
      click: 0,
      memory: 0
    };
  }
  return player.playsByDate[dateKey];
}

function cleanupExpiredTokens(data) {
  const now = Date.now();
  for (const [token, info] of Object.entries(data.playTokens)) {
    if (!info || !info.expiresAt || info.expiresAt < now || info.used) {
      delete data.playTokens[token];
    }
  }
}

function checkAdmin(req) {
  if (!ADMIN_KEY) return true;
  const key = req.header('x-admin-key');
  return key && key === ADMIN_KEY;
}

function uniqueNames(list) {
  const out = [];
  const seen = new Set();

  for (const raw of list) {
    const name = sanitizeName(raw);
    if (!name) continue;

    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;

    seen.add(lower);
    out.push(name);
  }

  return out;
}

function normalizePhaseRecord(payload) {
  if (!payload || typeof payload !== 'object') {
    return { error: 'Invalid history payload.' };
  }

  const playersRaw = Array.isArray(payload.players) ? payload.players : [];
  const players = uniqueNames(playersRaw);
  if (players.length < 2 || players.length > 12) {
    return { error: 'History must include 2 to 12 players.' };
  }

  const totals = {};
  const phases = {};

  for (const player of players) {
    const total = Number(payload.totals?.[player]);
    totals[player] = Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0;

    const phase = Number(payload.phases?.[player]);
    const safePhase = Number.isFinite(phase) ? Math.floor(phase) : 1;
    phases[player] = Math.max(1, Math.min(PHASE_FINISH, safePhase));
  }

  const winnersRaw = Array.isArray(payload.winners) ? payload.winners : [];
  const winners = uniqueNames(winnersRaw).filter((name) => players.includes(name));
  if (winners.length === 0) {
    return { error: 'History must include at least one winner.' };
  }

  const finishedRaw = Array.isArray(payload.finishedPlayers) ? payload.finishedPlayers : [];
  const finishedPlayers = uniqueNames(finishedRaw).filter((name) => players.includes(name));

  const roundsNum = Number(payload.rounds);
  const rounds = Number.isFinite(roundsNum) && roundsNum > 0 ? Math.floor(roundsNum) : 0;

  const playedAtRaw = payload.playedAt;
  const playedAtDate = typeof playedAtRaw === 'string' ? new Date(playedAtRaw) : new Date();
  const playedAt = Number.isNaN(playedAtDate.getTime()) ? new Date().toISOString() : playedAtDate.toISOString();

  return {
    record: {
      id: crypto.randomUUID(),
      playedAt,
      createdAt: Date.now(),
      players,
      rounds,
      totals,
      phases,
      winners,
      finishedPlayers,
      rule: sanitizeText(payload.rule, 80),
      detail: sanitizeText(payload.detail, 300)
    }
  };
}

function sortedPhaseHistory(history) {
  return [...history].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/phase/history', (_req, res) => {
  const data = readData();
  const history = sortedPhaseHistory(data.phaseHistory).slice(0, PHASE_HISTORY_LIMIT);
  res.json({ history });
});

app.post('/api/phase/history', (req, res) => {
  const normalized = normalizePhaseRecord(req.body);
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }

  const data = readData();
  data.phaseHistory = [normalized.record, ...data.phaseHistory].slice(0, PHASE_HISTORY_LIMIT);
  writeData(data);

  res.status(201).json({ ok: true, record: normalized.record });
});

app.get('/api/admin/phase/history', (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized admin request.' });

  const data = readData();
  const history = sortedPhaseHistory(data.phaseHistory).slice(0, PHASE_HISTORY_LIMIT);
  res.json({ history, count: history.length });
});

app.delete('/api/admin/phase/history', (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized admin request.' });

  const data = readData();
  data.phaseHistory = [];
  writeData(data);

  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const playerName = sanitizePlayerName(req.body?.name);
  if (!playerName) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  const data = readData();
  const player = ensurePlayer(data, playerName);
  const todayKey = getTodayKey();
  const daily = ensureDateBucket(player, todayKey);

  writeData(data);

  return res.json({
    name: playerName,
    score: player.score,
    gameLocked: data.gameLocked,
    dailyPlays: daily,
    limitPerGame: DAILY_PLAY_LIMIT,
    dateKey: todayKey
  });
});

app.post('/api/game/start', (req, res) => {
  const playerName = sanitizePlayerName(req.body?.name);
  const game = req.body?.game;

  if (!playerName) return res.status(400).json({ error: 'Name is required.' });
  if (!VALID_GAMES.has(game)) return res.status(400).json({ error: 'Invalid game.' });

  const data = readData();
  cleanupExpiredTokens(data);

  if (data.gameLocked) {
    writeData(data);
    return res.status(403).json({ error: 'Competition is currently locked by admin.' });
  }

  const player = ensurePlayer(data, playerName);
  const todayKey = getTodayKey();
  const daily = ensureDateBucket(player, todayKey);

  if (daily[game] >= DAILY_PLAY_LIMIT) {
    writeData(data);
    return res.status(429).json({
      error: `Daily limit reached for ${game}.`,
      dailyPlays: daily,
      limitPerGame: DAILY_PLAY_LIMIT
    });
  }

  daily[game] += 1;

  const token = crypto.randomUUID();
  data.playTokens[token] = {
    playerName,
    game,
    used: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + TOKEN_TTL_MS
  };

  writeData(data);

  return res.json({
    token,
    dailyPlays: daily,
    limitPerGame: DAILY_PLAY_LIMIT,
    expiresInMs: TOKEN_TTL_MS
  });
});

app.post('/api/game/submit', (req, res) => {
  const playerName = sanitizePlayerName(req.body?.name);
  const game = req.body?.game;
  const token = req.body?.token;
  const rawPoints = Number(req.body?.points);

  if (!playerName) return res.status(400).json({ error: 'Name is required.' });
  if (!VALID_GAMES.has(game)) return res.status(400).json({ error: 'Invalid game.' });
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Token is required.' });
  if (!Number.isFinite(rawPoints) || rawPoints < 0) return res.status(400).json({ error: 'Points must be a non-negative number.' });

  const points = Math.min(Math.floor(rawPoints), MAX_POINTS[game]);

  const data = readData();
  cleanupExpiredTokens(data);

  if (data.gameLocked) {
    writeData(data);
    return res.status(403).json({ error: 'Competition is currently locked by admin.' });
  }

  const tokenData = data.playTokens[token];
  if (!tokenData) {
    writeData(data);
    return res.status(400).json({ error: 'Play token is invalid or expired.' });
  }

  if (tokenData.used) {
    writeData(data);
    return res.status(400).json({ error: 'Play token has already been used.' });
  }

  if (tokenData.playerName !== playerName || tokenData.game !== game) {
    writeData(data);
    return res.status(403).json({ error: 'Token does not match player/game.' });
  }

  tokenData.used = true;

  const player = ensurePlayer(data, playerName);
  player.score += points;

  writeData(data);

  return res.json({
    addedPoints: points,
    totalScore: player.score
  });
});

app.get('/api/player/:name', (req, res) => {
  const playerName = sanitizePlayerName(req.params.name);
  if (!playerName) return res.status(400).json({ error: 'Invalid player name.' });

  const data = readData();
  const player = data.players[playerName];

  if (!player) {
    return res.status(404).json({ error: 'Player not found.' });
  }

  const todayKey = getTodayKey();
  const daily = player.playsByDate?.[todayKey] || { reaction: 0, click: 0, memory: 0 };

  return res.json({
    name: playerName,
    score: player.score,
    dailyPlays: daily,
    limitPerGame: DAILY_PLAY_LIMIT,
    gameLocked: data.gameLocked,
    dateKey: todayKey
  });
});

app.get('/api/leaderboard', (_req, res) => {
  const data = readData();

  const leaderboard = Object.entries(data.players)
    .map(([name, value]) => ({ name, score: value.score || 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  res.json({ leaderboard, gameLocked: data.gameLocked });
});

app.get('/api/admin/stats', (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized admin request.' });

  const data = readData();
  const todayKey = getTodayKey();

  const players = Object.entries(data.players).map(([name, player]) => ({
    name,
    score: player.score || 0,
    todayPlays: player.playsByDate?.[todayKey] || { reaction: 0, click: 0, memory: 0 }
  }));

  players.sort((a, b) => b.score - a.score);

  res.json({
    gameLocked: data.gameLocked,
    todayKey,
    limitPerGame: DAILY_PLAY_LIMIT,
    players
  });
});

app.post('/api/admin/lock', (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized admin request.' });

  const locked = Boolean(req.body?.locked);
  const data = readData();
  data.gameLocked = locked;
  writeData(data);

  res.json({ gameLocked: data.gameLocked });
});

app.post('/api/admin/reset', (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized admin request.' });

  const data = createDefaultData();
  writeData(data);
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
