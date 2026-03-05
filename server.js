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

const VALID_GAMES = new Set(['reaction', 'click', 'memory']);

const MAX_POINTS = {
  reaction: 500,
  click: 500,
  memory: 200
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readData() {
  if (!fs.existsSync(DATA_PATH)) {
    const defaultData = { gameLocked: false, players: {}, playTokens: {} };
    fs.writeFileSync(DATA_PATH, JSON.stringify(defaultData, null, 2), 'utf8');
    return defaultData;
  }

  const raw = fs.readFileSync(DATA_PATH, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(raw);

  data.gameLocked = Boolean(data.gameLocked);
  data.players = data.players || {};
  data.playTokens = data.playTokens || {};
  return data;
}

function writeData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function sanitizePlayerName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, 40);
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

app.get('/api/health', (_req, res) => {
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

app.get('/api/admin/stats', (_req, res) => {
  if (!checkAdmin(_req)) return res.status(401).json({ error: 'Unauthorized admin request.' });
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

app.post('/api/admin/reset', (_req, res) => {
  if (!checkAdmin(_req)) return res.status(401).json({ error: 'Unauthorized admin request.' });
  const data = { gameLocked: false, players: {}, playTokens: {} };
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




