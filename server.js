// ═══════════════════════════════════════════════════════
// ÆTHERFORGE BACKEND SERVER
// Node.js + Express + SQLite + WebSocket
// ═══════════════════════════════════════════════════════

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const path         = require('path');
const fs           = require('fs');
const Database     = require('better-sqlite3');

// ── INIT ──────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

// ── DATABASE ──────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'aetherforge.db');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT 'Unnamed Session',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    mode        TEXT DEFAULT 'workshop',
    play_time   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS crafted_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    recipe_id   TEXT NOT NULL,
    recipe_name TEXT NOT NULL,
    materials   TEXT NOT NULL,
    forged_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    pos_x       REAL DEFAULT 0,
    pos_y       REAL DEFAULT 1.2,
    pos_z       REAL DEFAULT -4,
    color       TEXT DEFAULT '#C8963E',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS inventory_slots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    slot_index  INTEGER NOT NULL,
    material    TEXT,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, slot_index),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS forge_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    event_data  TEXT,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS leaderboard (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    player_name TEXT NOT NULL DEFAULT 'Anonymous Artificer',
    items_forged INTEGER DEFAULT 0,
    rarest_item TEXT,
    score       INTEGER DEFAULT 0,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── MIDDLEWARE ────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','PATCH'] }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ───────────────────────────────────────────
function genId() {
  return 'aef_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function logEvent(sessionId, type, data) {
  try {
    db.prepare(
      'INSERT INTO forge_log (session_id, event_type, event_data) VALUES (?, ?, ?)'
    ).run(sessionId, type, JSON.stringify(data));
  } catch(e) { /* non-critical */ }
}

// ── RECIPE DATA ───────────────────────────────────────
const RECIPES = {
  'steam-pistol':      { name:'Steam Pistol',      tier:3, materials:['brass','iron','spring','valve','leather'],              stats:{Power:78,Precision:65,Durability:90,Rarity:60},  category:'Weapons'     },
  'aether-compass':    { name:'Aether Compass',    tier:2, materials:['brass','crystal','aether','lens'],                     stats:{Accuracy:95,Range:88,Sensitivity:72,Rarity:75},  category:'Instruments' },
  'clockwork-heart':   { name:'Clockwork Heart',   tier:4, materials:['gold','crystal','spring','coil','aether','quicksilver'],stats:{Efficiency:99,Durability:85,Magic:88,Rarity:95}, category:'Components'  },
  'voltaic-gauntlet':  { name:'Voltaic Gauntlet',  tier:3, materials:['copper','coil','crystal','leather','rubber'],          stats:{Power:92,Control:55,Durability:70,Rarity:80},    category:'Armor'       },
  'alchemist-lens':    { name:"Alchemist's Lens",  tier:2, materials:['crystal','silver','brass','lens'],                    stats:{Vision:95,Clarity:88,Range:60,Rarity:55},        category:'Instruments' },
  'phoenix-cannon':    { name:'Phoenix Cannon',    tier:5, materials:['dragon-gem','gold','brass','coil','sulfur','steel'],   stats:{Power:100,Range:90,Destruction:97,Rarity:100},   category:'Weapons'     },
  'chrono-pocket-watch':{ name:'Chrono-Watch',     tier:3, materials:['gold','spring','crystal','leather','quicksilver'],     stats:{Precision:100,Temporal:78,Luxury:92,Rarity:85},  category:'Instruments' },
  'steam-golem-core':  { name:'Golem Core',        tier:5, materials:['iron','brass','copper','aether','chimera-scale'],     stats:{Power:98,Obedience:65,Durability:100,Rarity:100},category:'Arcane'      },
  'void-lantern':      { name:'Void Lantern',      tier:4, materials:['void-shard','brass','crystal','silver','aether'],     stats:{Illumination:100,Range:88,Mysticism:95,Rarity:90},category:'Arcane'     },
  'bone-automaton':    { name:'Bone Automaton',    tier:4, materials:['bone','spring','copper','amber','gear'],              stats:{Speed:82,Loyalty:100,Stealth:75,Rarity:88},      category:'Familiars'   },
  'steam-jetpack':     { name:'Steam Jetpack',     tier:3, materials:['iron','copper','valve','rubber','leather','piston'],  stats:{Thrust:85,Duration:60,Safety:50,Rarity:70},      category:'Armor'       },
  'arcane-codex':      { name:'Arcane Codex',      tier:2, materials:['chimera-scale','wood','gold','aether'],              stats:{Knowledge:100,Portability:80,Durability:70,Rarity:65},category:'Instruments'},
};

function calcScore(recipe) {
  const r = RECIPES[recipe];
  if (!r) return 0;
  const statValues = Object.values(r.stats);
  const avg = statValues.reduce((a,b)=>a+b,0) / statValues.length;
  return Math.round(avg * r.tier * 1.5);
}

// ═══════════════════════════════════════════════════════
//  REST API ROUTES
// ═══════════════════════════════════════════════════════

// ── ROOT ──────────────────────────────────────────────
app.get('/api', (req, res) => {
  res.json({
    name:    'Ætherforge API',
    version: '1.0.0',
    status:  'operational',
    uptime:  Math.floor(process.uptime()),
    endpoints: [
      'GET  /api/recipes',
      'GET  /api/sessions',
      'POST /api/sessions',
      'GET  /api/sessions/:id',
      'PUT  /api/sessions/:id',
      'DELETE /api/sessions/:id',
      'GET  /api/sessions/:id/items',
      'POST /api/sessions/:id/forge',
      'GET  /api/sessions/:id/inventory',
      'PUT  /api/sessions/:id/inventory',
      'GET  /api/sessions/:id/log',
      'GET  /api/leaderboard',
      'POST /api/leaderboard',
      'GET  /api/stats',
    ]
  });
});

// ── RECIPES ───────────────────────────────────────────
app.get('/api/recipes', (req, res) => {
  const { category, tier } = req.query;
  let list = Object.entries(RECIPES).map(([id, r]) => ({ id, ...r }));
  if (category) list = list.filter(r => r.category.toLowerCase() === category.toLowerCase());
  if (tier)     list = list.filter(r => r.tier === parseInt(tier));
  res.json({ count: list.length, recipes: list });
});

app.get('/api/recipes/:id', (req, res) => {
  const recipe = RECIPES[req.params.id];
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  res.json({ id: req.params.id, ...recipe });
});

// ── SESSIONS ──────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  const sessions = db.prepare(`
    SELECT s.*, COUNT(c.id) as items_forged
    FROM sessions s
    LEFT JOIN crafted_items c ON c.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT 50
  `).all();
  res.json({ count: sessions.length, sessions });
});

app.post('/api/sessions', (req, res) => {
  const { name = 'New Workshop Session' } = req.body;
  const id = genId();
  db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(id, name);

  // Init 4 inventory slots
  const insertSlot = db.prepare('INSERT INTO inventory_slots (session_id, slot_index) VALUES (?, ?)');
  [0,1,2,3].forEach(i => insertSlot.run(id, i));

  logEvent(id, 'SESSION_CREATED', { name });
  broadcast({ type: 'SESSION_CREATED', sessionId: id, name });
  res.status(201).json({ id, name, created_at: new Date().toISOString() });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const items    = db.prepare('SELECT * FROM crafted_items WHERE session_id = ? ORDER BY forged_at DESC').all(req.params.id);
  const slots    = db.prepare('SELECT * FROM inventory_slots WHERE session_id = ? ORDER BY slot_index').all(req.params.id);
  const logCount = db.prepare('SELECT COUNT(*) as c FROM forge_log WHERE session_id = ?').get(req.params.id);

  res.json({ ...session, items, inventory_slots: slots, log_entries: logCount.c });
});

app.put('/api/sessions/:id', (req, res) => {
  const { name, mode, play_time } = req.body;
  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  db.prepare(`
    UPDATE sessions SET
      name       = COALESCE(?, name),
      mode       = COALESCE(?, mode),
      play_time  = COALESCE(?, play_time),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, mode, play_time, req.params.id);

  res.json({ success: true, id: req.params.id });
});

app.delete('/api/sessions/:id', (req, res) => {
  const r = db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Session not found' });
  broadcast({ type: 'SESSION_DELETED', sessionId: req.params.id });
  res.json({ success: true, deleted: req.params.id });
});

// ── FORGE (CRAFT) ─────────────────────────────────────
app.post('/api/sessions/:id/forge', (req, res) => {
  const { recipe_id, pos_x = 0, pos_y = 1.2, pos_z = -4 } = req.body;
  if (!recipe_id) return res.status(400).json({ error: 'recipe_id required' });

  const recipe = RECIPES[recipe_id];
  if (!recipe) return res.status(404).json({ error: 'Unknown recipe' });

  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Simulate forge time based on tier (ms, not real — just stored)
  const forgeMs = recipe.tier * 800 + Math.floor(Math.random() * 600);

  const COLORS = {
    'steam-pistol':'#C8963E','aether-compass':'#5AEAF0','clockwork-heart':'#FF6B6B',
    'voltaic-gauntlet':'#FFB347','alchemist-lens':'#8BCFD0','phoenix-cannon':'#FF4400',
    'chrono-pocket-watch':'#D4AF37','steam-golem-core':'#6A8A6A','void-lantern':'#8A2090',
    'bone-automaton':'#E8DCC8','steam-jetpack':'#8B5E3C','arcane-codex':'#2A6070',
  };

  const result = db.prepare(`
    INSERT INTO crafted_items (session_id, recipe_id, recipe_name, materials, pos_x, pos_y, pos_z, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id, recipe_id, recipe.name,
    JSON.stringify(recipe.materials),
    pos_x, pos_y, pos_z,
    COLORS[recipe_id] || '#C8963E'
  );

  db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  logEvent(req.params.id, 'ITEM_FORGED', { recipe_id, recipe_name: recipe.name });

  const item = {
    id:          result.lastInsertRowid,
    session_id:  req.params.id,
    recipe_id,
    recipe_name: recipe.name,
    materials:   recipe.materials,
    color:       COLORS[recipe_id] || '#C8963E',
    pos_x, pos_y, pos_z,
    score:       calcScore(recipe_id),
    forge_ms:    forgeMs,
    forged_at:   new Date().toISOString(),
  };

  broadcast({ type: 'ITEM_FORGED', sessionId: req.params.id, item });
  res.status(201).json(item);
});

// ── INVENTORY SLOTS ───────────────────────────────────
app.get('/api/sessions/:id/inventory', (req, res) => {
  const slots = db.prepare(
    'SELECT * FROM inventory_slots WHERE session_id = ? ORDER BY slot_index'
  ).all(req.params.id);
  if (!slots.length) return res.status(404).json({ error: 'Session not found' });
  res.json({ session_id: req.params.id, slots });
});

app.put('/api/sessions/:id/inventory', (req, res) => {
  const { slots } = req.body; // array of { slot_index, material }
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots array required' });

  const update = db.prepare(`
    INSERT INTO inventory_slots (session_id, slot_index, material, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id, slot_index) DO UPDATE SET material = excluded.material, updated_at = CURRENT_TIMESTAMP
  `);

  const updateMany = db.transaction((rows) => rows.forEach(s => update.run(req.params.id, s.slot_index, s.material || null)));
  updateMany(slots);

  logEvent(req.params.id, 'INVENTORY_UPDATED', { slots });
  broadcast({ type: 'INVENTORY_UPDATED', sessionId: req.params.id, slots });
  res.json({ success: true, updated: slots.length });
});

// ── CRAFTED ITEMS ─────────────────────────────────────
app.get('/api/sessions/:id/items', (req, res) => {
  const items = db.prepare(
    'SELECT * FROM crafted_items WHERE session_id = ? ORDER BY forged_at DESC'
  ).all(req.params.id);
  res.json({ count: items.length, items });
});

app.delete('/api/sessions/:id/items/:itemId', (req, res) => {
  const r = db.prepare(
    'DELETE FROM crafted_items WHERE id = ? AND session_id = ?'
  ).run(req.params.itemId, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Item not found' });
  broadcast({ type: 'ITEM_REMOVED', sessionId: req.params.id, itemId: req.params.itemId });
  res.json({ success: true });
});

// ── FORGE LOG ─────────────────────────────────────────
app.get('/api/sessions/:id/log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const log = db.prepare(
    'SELECT * FROM forge_log WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(req.params.id, limit);
  res.json({ count: log.length, log });
});

// ── LEADERBOARD ───────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const top = db.prepare(`
    SELECT l.*, s.name as session_name
    FROM leaderboard l
    LEFT JOIN sessions s ON s.id = l.session_id
    ORDER BY l.score DESC
    LIMIT 20
  `).all();
  res.json({ count: top.length, leaderboard: top });
});

app.post('/api/leaderboard', (req, res) => {
  const { session_id, player_name = 'Anonymous Artificer' } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const items = db.prepare(
    'SELECT recipe_id FROM crafted_items WHERE session_id = ?'
  ).all(session_id);

  const totalScore = items.reduce((sum, i) => sum + calcScore(i.recipe_id), 0);
  const rarest = items.reduce((best, i) => {
    const r = RECIPES[i.recipe_id];
    if (!r) return best;
    const rarity = r.stats.Rarity || 0;
    return (!best || rarity > (RECIPES[best.recipe_id]?.stats?.Rarity || 0)) ? i : best;
  }, null);

  const entry = db.prepare(`
    INSERT INTO leaderboard (session_id, player_name, items_forged, rarest_item, score)
    VALUES (?, ?, ?, ?, ?)
  `).run(session_id, player_name, items.length, rarest?.recipe_id || null, totalScore);

  broadcast({ type: 'LEADERBOARD_UPDATED', player_name, score: totalScore });
  res.status(201).json({
    id:           entry.lastInsertRowid,
    session_id,
    player_name,
    items_forged: items.length,
    rarest_item:  rarest?.recipe_id,
    score:        totalScore,
  });
});

// ── GLOBAL STATS ──────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const totalSessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  const totalItems    = db.prepare('SELECT COUNT(*) as c FROM crafted_items').get().c;
  const topRecipe     = db.prepare(`
    SELECT recipe_id, recipe_name, COUNT(*) as times_forged
    FROM crafted_items GROUP BY recipe_id ORDER BY times_forged DESC LIMIT 1
  `).get();
  const recentItems   = db.prepare(`
    SELECT recipe_name, forged_at FROM crafted_items ORDER BY forged_at DESC LIMIT 5
  `).all();
  const activeSessions = wss.clients.size;

  res.json({
    total_sessions:   totalSessions,
    total_items:      totalItems,
    active_ws_clients: activeSessions,
    top_recipe:       topRecipe,
    recent_forges:    recentItems,
    server_uptime_s:  Math.floor(process.uptime()),
  });
});

// ── 404 ───────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));

// ── ERROR HANDLER ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// ═══════════════════════════════════════════════════════
//  WEBSOCKET SERVER
// ═══════════════════════════════════════════════════════

wss.on('connection', (ws, req) => {
  const clientId = genId();
  ws.clientId = clientId;
  console.log(`[WS] Client connected: ${clientId} (total: ${wss.clients.size})`);

  ws.send(JSON.stringify({
    type:       'CONNECTED',
    clientId,
    message:    'Welcome to Ætherforge Workshop',
    timestamp:  new Date().toISOString(),
    clients:    wss.clients.size,
  }));

  broadcast({ type: 'CLIENT_COUNT', count: wss.clients.size });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleWSMessage(ws, msg);
    } catch(e) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${clientId}`);
    broadcast({ type: 'CLIENT_COUNT', count: wss.clients.size });
  });

  ws.on('error', (e) => console.error('[WS] Error:', e.message));
});

function handleWSMessage(ws, msg) {
  switch(msg.type) {
    case 'PING':
      ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      break;

    case 'JOIN_SESSION':
      ws.sessionId = msg.sessionId;
      ws.send(JSON.stringify({ type: 'SESSION_JOINED', sessionId: msg.sessionId }));
      break;

    case 'OBJECT_MOVED':
      // Broadcast position update to all other clients
      broadcast({ type: 'OBJECT_MOVED', ...msg, from: ws.clientId });
      break;

    case 'MATERIAL_DROPPED':
      broadcast({ type: 'MATERIAL_DROPPED', ...msg, from: ws.clientId });
      break;

    case 'FORGE_START':
      broadcast({ type: 'FORGE_START', ...msg, from: ws.clientId });
      // Auto-complete after tier * 1000ms
      const recipe = RECIPES[msg.recipe_id];
      if (recipe) {
        setTimeout(() => {
          broadcast({ type: 'FORGE_COMPLETE', recipe_id: msg.recipe_id, session_id: msg.session_id });
        }, recipe.tier * 1000);
      }
      break;

    case 'CHAT':
      broadcast({ type: 'CHAT', from: ws.clientId, text: msg.text, timestamp: Date.now() });
      break;

    default:
      ws.send(JSON.stringify({ type: 'UNKNOWN', received: msg.type }));
  }
}

// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║      ⚙  ÆTHERFORGE SERVER  ⚙         ║
  ╠═══════════════════════════════════════╣
  ║  HTTP  →  http://localhost:${PORT}       ║
  ║  WS    →  ws://localhost:${PORT}         ║
  ║  API   →  http://localhost:${PORT}/api   ║
  ╚═══════════════════════════════════════╝
  `);
});

module.exports = { app, server, db };