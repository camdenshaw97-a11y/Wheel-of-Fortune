'use strict';
/*
 * Friend Wheel server.
 * One process holds every room in memory. The TV page creates a room, phones join it with a
 * 4-letter code, and the server is the single source of truth: every change is pushed to every
 * screen as a fresh snapshot.
 *
 * Built the same way as Friend Feud and Friend Jeopardy: the same join flow, the same reconnect
 * and restart-survival tricks. The difference: the game runs itself. Letters and solves are
 * typed on the phones and checked here, so a host is optional.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const BANK = require('./puzzles');
const Board = require('./board');

const PORT = process.env.PORT || 3000;
const PUB = __dirname;
// Only the page files are ever handed to a browser: the puzzles and the server code stay here.
const PAGE_FILES = new Set(['index.html', 'tv.html', 'common.js', 'board.js', 'editor.js', 'style.css', 'anton.woff2', 'lobby.mp3']);
// Walkthrough videos get unlisted pages of their own (none yet). See Friend Jeopardy for how.
const PROMOS = {};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json', '.mp3': 'audio/mpeg'
};

// A fingerprint of the pages as they are right now, so a screen left open across an update reloads itself.
const BUILD = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['index.html', 'tv.html', 'common.js', 'board.js', 'editor.js', 'style.css']) {
    try { h.update(fs.readFileSync(path.join(PUB, f))); } catch (e) { /* missing file: nothing to add */ }
  }
  return h.digest('hex').slice(0, 12);
})();

/* ---------------------------------------------------------------- rules */

const VOWEL_COST = 250;
const HOUSE_MIN = 1000;                   // solving a round always pays at least this
const TOSS_VALUES = [1000, 2000, 3000];   // the toss-up before round 1, round 2, round 3 and on
const TOSS_FIRST_MS = 2600;               // the first toss-up letter waits for the intro
const TOSS_TICK_MS = 1000;                // a new toss-up letter every second
const TOSS_GRACE_MS = 5000;               // once every letter is up, this long to buzz before it's dead
const TOSS_ANSWER_SECS = 15;              // to type a toss-up answer after buzzing
const SOLVE_SECS = 45;                    // to type a solve
const LETTER_CHOICES = [0, 10, 15, 20];   // the clock for calling a letter after a spin (0 = no clock)
const ROUND_CHOICES = [2, 3, 4];
const BONUS_GIVEN = 'RSTLNE';
const BONUS_SECS = 10;
const BONUS_PICK_SECS = 60;
const PAUSE_MS = 1700;                    // a missed letter, a Bankrupt or Lose a Turn stays up this long
const AFTER_SOLVE_MS = 6500;
const AFTER_TOSS_MS = 4000;
const LETTER_MS = 750;                    // each tile that lights up
const IDLE_SKIP_MS = 20000;               // a player whose phone dropped mid-turn is skipped after this
const MAX_PLAYERS = 8;
const SPEED = Number(process.env.SPEED_UP) || 1;   // tests run the clocks faster
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

// The wheels. 24 wedges each; 'BK' is Bankrupt, 'LT' is Lose a Turn.
const WHEELS = {
  w1: [2500, 600, 700, 600, 650, 500, 700, 'BK', 600, 550, 500, 900, 'LT', 650, 700, 800, 500, 650, 'BK', 500, 900, 550, 600, 800],
  w2: [3500, 650, 700, 600, 800, 500, 700, 'BK', 600, 550, 650, 900, 'LT', 650, 700, 800, 500, 650, 'BK', 550, 900, 600, 700, 800],
  w3: [5000, 700, 800, 600, 850, 650, 700, 'BK', 600, 900, 650, 900, 'LT', 700, 800, 850, 600, 650, 'BK', 700, 900, 600, 700, 800],
  bonus: [40000, 45000, 30000, 35000, 40000, 100000, 32000, 38000, 45000, 34000, 40000, 36000, 50000, 30000, 42000, 35000, 40000, 33000, 45000, 38000, 40000, 36000, 32000, 48000]
};
const WEDGE_DEG = 360 / 24;
const wheelFor = (round, rounds) => (round === 1 ? 'w1' : round === rounds && rounds >= 3 ? 'w3' : 'w2');
const wedgeAt = a => Math.floor((((360 - (a % 360)) % 360)) / WEDGE_DEG) % 24;

// Surviving a restart: the TV keeps a sealed copy of its room and hands it back if it ever
// reconnects to a server that has forgotten it (see packRoom and restoreRoom).
const BOOT = Date.now();
const RESTORE_WINDOW_MS = Number(process.env.RESTORE_WINDOW_MS) || 10 * 60 * 1000;
const RESTORE_GRACE_MS = 5000;
const SEAT_HOLD_MS = Number(process.env.SEAT_HOLD_MS) || 30000;
const STRAGGLER_MS = Number(process.env.STRAGGLER_MS) || 3 * 60 * 1000;
const BACKUP_V = 1;
const BACKUP_DELAY_MS = 200;
const BACKUP_MAX = 380 * 1024;
const BACKUP_KEY = (() => {
  let seed = process.env.BACKUP_KEY || process.env.RENDER_SERVICE_ID;
  if (!seed) {
    const file = path.join(__dirname, '.backup-key');
    try { seed = fs.readFileSync(file, 'utf8').trim(); } catch (e) { /* first run */ }
    if (!seed) {
      seed = crypto.randomBytes(32).toString('hex');
      try { fs.writeFileSync(file, seed + '\n', { mode: 0o600 }); } catch (e) { /* read-only disk */ }
    }
  }
  return crypto.createHash('sha256').update('friend-wheel room backup|' + seed).digest();
})();

const DEFAULT_SETTINGS = { packs: ['classic'], useCustom: true, rounds: 3, letterSecs: 15, bonus: true };
const rooms = new Map();

/* ------------------------------------------------------------------ http */

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  let p;
  try { p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (p === '/version') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end(BUILD); }
  if (p === '/uptime') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end('started ' + new Date(BOOT).toISOString() + ' · up ' + Math.round((Date.now() - BOOT) / 1000) + 's');
  }
  if (p === '/qr.svg') {
    const text = (u.searchParams.get('u') || '').slice(0, 300);
    return QRCode.toString(text || ' ', { type: 'svg', margin: 1, errorCorrectionLevel: 'L' }, (err, svg) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
      res.end(svg);
    });
  }
  const promo = Object.keys(PROMOS).find(base => p === base || p.startsWith(base + '/'));
  if (promo) return sendPromo(req, res, promo, p.slice(promo.length).replace(/\/$/, ''));
  if (p === '/') p = '/index.html';
  if (p === '/tv') p = '/tv.html';
  const rel = p.replace(/^\/+/, '');
  if (!PAGE_FILES.has(rel)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  const file = path.join(PUB, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    if (ext === '.html') data = Buffer.from(String(data).replace('<html lang="en">', '<html lang="en" data-build="' + BUILD + '">'));
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.woff2' ? 'public, max-age=604800' : ext === '.mp3' ? 'public, max-age=3600' : 'no-cache'
    });
    res.end(data);
  });
});

// A walkthrough video page and its two files, sent in pieces so iPhones will play it.
function sendPromo(req, res, base, sub) {
  const P = PROMOS[base];
  const entry = { '': ['promo.html', 'text/html; charset=utf-8'], '/video.mp4': [P.video, 'video/mp4'], '/poster.jpg': [P.poster, 'image/jpeg'] }[sub];
  const gone = () => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); };
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) return gone();
  const file = path.join(PUB, entry[0]), type = entry[1];
  const head = { 'content-type': type, 'x-robots-tag': 'noindex, nofollow' };
  if (sub === '') {
    return fs.readFile(file, 'utf8', (err, html) => {
      if (err) return gone();
      const host = /^[a-z0-9.:-]+$/i.test(req.headers.host || '') ? req.headers.host : 'localhost';
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';
      const body = Buffer.from(html.split('{{HERE}}').join(proto + '://' + host + base).split('{{PATH}}').join(base).split('{{TITLE}}').join(P.title).split('{{HEAD}}').join(P.head));
      res.writeHead(200, Object.assign(head, { 'cache-control': 'no-cache', 'content-length': body.length }));
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return gone();
    let start = 0, end = st.size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1] === '') start = Math.max(0, st.size - Number(m[2]));
      else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); return res.end(); }
      code = 206;
      head['content-range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    res.writeHead(code, Object.assign(head, { 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400' }));
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

/* --------------------------------------------------------------- helpers */

const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeCode() {
  const letters = 'BCDFGHJKLMNPQRSTVWXZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// The host's own puzzles: a category and a puzzle that fits the board.
function cleanCustom(c) {
  const out = { puzzles: [] };
  if (!c || typeof c !== 'object') return out;
  for (const x of (Array.isArray(c.puzzles) ? c.puzzles.slice(0, 300) : [])) {
    if (!x || typeof x !== 'object') continue;
    const cat = clean(x.cat, 30).toUpperCase(), text = Board.tidy(clean(x.text, 60));
    if (cat && text && !Board.layout(text).err) out.puzzles.push({ cat, text });
  }
  return out;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/* ----------------------------------------------------------------- rooms */

function newRoom() {
  const room = {
    code: makeCode(),
    adminToken: rid(),
    touched: Date.now(),
    displays: new Set(),
    players: new Map(),
    order: [],            // contestants, in the order they joined: their spots on the TV and the turn order
    hostId: null,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    custom: { puzzles: [] },
    used: new Set(),      // puzzles already seen on this TV
    game: null,
    history: [],
    fx: [],
    fxSeq: 0,
    timer: null           // the one server clock (see armTimer)
  };
  rooms.set(room.code, room);
  return room;
}

function fx(room, type, data) {
  room.fx.push(Object.assign({ seq: ++room.fxSeq, type }, data || {}));
  if (room.fx.length > 14) room.fx.shift();
}

const pname = (room, id) => { const p = room.players.get(id); return p ? p.name : null; };
const contestants = room => room.order.filter(id => room.players.has(id));
const hostOn = room => { const h = room.hostId && room.players.get(room.hostId); return !!(h && h.connected); };
// With no host, the first player runs the lobby: settings, Start, and Play again.
const captainId = room => (hostOn(room) ? null : contestants(room)[0] || null);

/* ---------------------------------------------------- surviving a restart */

function packRoom(room, lean) {
  const data = {
    v: BACKUP_V, at: Date.now(), code: room.code, adminToken: room.adminToken,
    players: [...room.players.values()].map(p => ({ id: p.id, token: p.token, name: p.name, isHost: p.isHost })),
    order: room.order, hostId: room.hostId, settings: room.settings, custom: room.custom, used: [...room.used],
    game: room.game, history: lean ? [] : room.history, fxSeq: room.fxSeq
  };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', BACKUP_KEY, iv);
  const body = Buffer.concat([c.update(zlib.deflateRawSync(JSON.stringify(data))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function unpackRoom(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  if (raw.length < 30) throw new Error('too short');
  const d = crypto.createDecipheriv('aes-256-gcm', BACKUP_KEY, raw.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(raw.subarray(12, 28));
  const body = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  return JSON.parse(zlib.inflateRawSync(body, { maxOutputLength: 16 * 1024 * 1024 }));
}

function sendBackup(room) {
  if (rooms.get(room.code) !== room) return;
  const to = [...room.displays].filter(ws => ws.admin && ws.readyState === 1);
  if (!to.length) return;
  let blob;
  try {
    blob = packRoom(room, false);
    if (blob.length > BACKUP_MAX) blob = packRoom(room, true);
  } catch (e) { return console.error('backup error', e); }
  if (blob.length > BACKUP_MAX) return;
  const msg = JSON.stringify({ t: 'backup', code: room.code, blob });
  for (const ws of to) ws.send(msg);
}

function queueBackup(room) {
  if (room.backupTimer) return;
  room.backupTimer = setTimeout(() => { room.backupTimer = null; sendBackup(room); }, BACKUP_DELAY_MS);
}

function restoreRoom(blob, code, token, idle) {
  let d;
  try { d = unpackRoom(blob); } catch (e) { return null; }
  if (!d || d.v !== BACKUP_V || d.code !== code || !token || d.adminToken !== token) return null;
  if (!(Date.now() - d.at < ROOM_IDLE_MS) || rooms.has(code)) return null;
  const room = {
    code, adminToken: d.adminToken, touched: Date.now(), displays: new Set(), players: new Map(),
    order: d.order || [], hostId: d.hostId, settings: Object.assign({}, DEFAULT_SETTINGS, d.settings),
    custom: cleanCustom(d.custom), used: new Set(d.used),
    game: d.game, history: d.history || [], fx: [], fxSeq: (d.fxSeq || 0) + 50, timer: null
  };
  const hold = Date.now() + SEAT_HOLD_MS;
  for (const p of d.players) room.players.set(p.id, { id: p.id, token: p.token, name: p.name, isHost: p.isHost, connected: false, ws: null, hold, goneAt: Date.now() + SEAT_HOLD_MS });
  const g = room.game;
  if (g && g.clock) {
    // The clock stood still while the server was away: give it back its time, plus a moment to reconnect.
    const used = Math.max(0, Math.min(Number(idle) || 0, 10 * 60 * 1000));
    g.clock.at = Date.now() + Math.max(0, g.clock.at - d.at - used) + RESTORE_GRACE_MS;
    if (g.phase === 'spinning' || g.phase === 'bonusSpinning') { g.wheel.from = g.wheel.angle; g.wheel.at = Date.now(); g.wheel.dur = 1; }
  }
  try { publicState(room); } catch (e) { console.error('restore error', e); return null; }
  rooms.set(code, room);
  armTimer(room);
  room.tidyTimer = setTimeout(() => {
    room.tidyTimer = null;
    if (rooms.get(code) !== room || room.game) return;
    let gone = 0;
    for (const p of [...room.players.values()]) if (!p.connected && !p.isHost && !room.order.includes(p.id)) { room.players.delete(p.id); gone++; }
    if (gone) pushAll(room);
  }, STRAGGLER_MS);
  fx(room, 'restored');
  console.log('restored room ' + code + ' (' + room.players.size + ' players, ' + (g ? g.phase : 'lobby') + ')');
  return room;
}

/* --------------------------------------------------------------- puzzles */

const packIds = () => BANK.packs.map(p => p.id);
const customKey = x => 'c:' + x.text.toLowerCase().slice(0, 60);

/*
 * No repeats. room.used remembers every puzzle this TV has shown, oldest first. The never-seen
 * ones come first (shuffled), then the seen ones starting with the oldest.
 */
function markUsed(room, key) {
  room.used.delete(key);
  room.used.add(key);
  if (room.used.size > 3000) room.used.delete(room.used.values().next().value);
}

function freshFirst(room, items) {
  const rank = new Map([...room.used].map((k, i) => [k, i]));
  const fresh = shuffle(items.filter(x => !rank.has(x.key)));
  const seen = items.filter(x => rank.has(x.key)).sort((a, b) => rank.get(a.key) - rank.get(b.key));
  return fresh.concat(seen);
}

// kind: 'toss' (any puzzle), 'round' (any), 'bonus' (short ones).
function drawPuzzle(room, kind) {
  const g = room.game;
  const on = (room.settings.packs || []).filter(id => packIds().includes(id));
  const ids = on.length ? on : ['classic'];
  const mine = room.settings.useCustom ? room.custom.puzzles.map(x => ({ key: customKey(x), cat: x.cat, text: x.text, pack: 'custom' })) : [];
  const built = BANK.puzzles.filter(x => ids.includes(x.pack)).map(x => ({ key: x.id, cat: x.cat, text: x.text, pack: x.pack }));
  const fits = x => {
    const n = Board.letters(x.text).length, words = x.text.split(' ').length;
    if (kind === 'bonus') return n >= 6 && n <= 15 && words <= 3;
    if (kind === 'toss') return n >= 9;
    return n >= 10;
  };
  let deck = freshFirst(room, mine).concat(freshFirst(room, built)).filter(x => !g.drawn.includes(x.key));
  let pick = deck.find(fits) || deck[0];
  if (!pick) {
    // Everything in the packs you have on has been played in this game: start again from the oldest.
    deck = freshFirst(room, mine.concat(built));
    pick = deck.find(fits) || deck[0];
  }
  if (!pick) pick = { key: 'fallback', cat: 'PHRASE', text: 'SPIN THE WHEEL', pack: 'classic' };
  markUsed(room, pick.key); g.drawn.push(pick.key);
  const lay = Board.layout(pick.text);
  return { cat: pick.cat, text: lay.text, cells: lay.cells, pack: pick.pack };
}

function packName(id) {
  if (id === 'custom') return 'Your puzzles';
  const p = BANK.packs.find(p => p.id === id);
  return p ? p.name : null;
}

/* ------------------------------------------------------------ the board */

const cellsOf = (g, letter) => g.puz.cells.map((c, k) => (c.ch === letter && !g.open[k] ? k : -1)).filter(k => k >= 0);
const hiddenLeft = g => g.puz.cells.some((c, k) => Board.isLetter(c.ch) && !g.open[k]);
const hiddenOf = (g, test) => g.puz.cells.some((c, k) => Board.isLetter(c.ch) && !g.open[k] && test(c.ch));
// Calling a letter that isn't in the puzzle is a miss even if nothing is left, so "left" means
// "not yet called", the way the show's used-letter board works.
const consLeft = g => 'BCDFGHJKLMNPQRSTVWXYZ'.split('').some(l => !g.called.includes(l)) && hiddenOf(g, ch => !Board.isVowel(ch));
const vowelsLeft = g => 'AEIOU'.split('').some(l => !g.called.includes(l)) && hiddenOf(g, ch => Board.isVowel(ch));

function setPuzzle(g, puz) {
  g.puz = puz;
  g.open = puz.cells.map(c => !Board.isLetter(c.ch));
  g.called = [];
}

function openAll(g) { g.open = g.puz.cells.map(() => true); }

/* ------------------------------------------------------------ game logic */

function snapshot(room) {
  room.history.push(JSON.stringify(room.game));
  if (room.history.length > 60) room.history.shift();
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function setClock(room, what, ms) {
  ms = Math.round(ms / SPEED);
  room.game.clock = { what, at: Date.now() + ms, len: ms };
  armTimer(room);
}
function stopClock(room) {
  if (room.game) room.game.clock = null;
  clearTimer(room);
}

// One server clock per room: whatever the game is waiting for next.
function armTimer(room) {
  clearTimer(room);
  const g = room.game;
  if (!g || !g.clock) return;
  const c = g.clock;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.game !== g || g.clock !== c) return;
    g.clock = null;
    try { onClock(room, c.what); } catch (e) { console.error('clock error', e); }
    pushAll(room);
  }, Math.max(0, c.at - Date.now()));
}

function onClock(room, what) {
  const g = room.game;
  switch (what) {
    case 'tossTick': tossTick(room); break;
    case 'tossDead': tossOver(room, null); break;
    case 'tossAnswer': tossWrong(room, true); break;
    case 'afterToss': afterToss(room); break;
    case 'land': land(room); break;
    case 'call': miss(room, 'time'); break;           // took too long to call a letter
    case 'lit': g.phase = 'turn'; g.last = null; break;
    case 'next': nextTurn(room); break;
    case 'solve': miss(room, 'time'); break;
    case 'afterSolve': afterRound(room); break;
    case 'bonusLand': bonusLanded(room); break;
    case 'bonusGiven': g.phase = 'bonusPick'; setClock(room, 'bonusPick', BONUS_PICK_SECS * 1000); break;
    case 'bonusPick': bonusPicks(room, autoPicks(g)); break;      // ran out of time picking: the game picks for them
    case 'bonusLit': g.phase = 'bonusSolve'; setClock(room, 'bonusSolve', BONUS_SECS * 1000 + 600); break;
    case 'bonusSolve': bonusOver(room, false); break;
    case 'afterBonus': endGame(room); break;
  }
}

function stat(room, id) {
  const g = room.game;
  if (!id || !g) return null;
  if (!g.stats) g.stats = {};
  return g.stats[id] || (g.stats[id] = { hits: 0, misses: 0, letterCash: 0, best: 0, vowels: 0, bankrupts: 0, lost: 0, solves: 0, tosses: 0, roundCash: 0 });
}

function startGame(room) {
  const ids = contestants(room);
  if (!ids.length) return;
  room.history = [];
  const total = {}, bank = {};
  for (const id of ids) { total[id] = 0; bank[id] = 0; }
  room.game = {
    phase: 'toss', round: 1, rounds: room.settings.rounds, kind: 'toss',
    total, bank, control: null, starter: null, drawn: [],
    puz: null, open: [], called: [],
    wheel: { kind: 'w1', angle: crypto.randomInt(360), from: 0, at: 0, dur: 0, idx: null },
    toss: null, last: null, clock: null, bonus: null, winner: null, stats: {}, solvedBy: null
  };
  room.game.wheel.from = room.game.wheel.angle;
  fx(room, 'start');
  startToss(room, null);
}

/* -------- toss-ups: letters appear one at a time; first to buzz and type it right wins */

function startToss(room, only) {
  const g = room.game;
  g.kind = 'toss';
  setPuzzle(g, drawPuzzle(room, 'toss'));
  const letterCells = g.puz.cells.map((c, k) => (Board.isLetter(c.ch) ? k : -1)).filter(k => k >= 0);
  g.toss = {
    value: only ? 0 : TOSS_VALUES[Math.min(g.round, TOSS_VALUES.length) - 1],
    order: shuffle(letterCells), out: [], buzzed: null, only: only || null, winner: null, guess: null
  };
  g.phase = 'toss'; g.control = null; g.last = null; g.solvedBy = null;
  fx(room, 'toss', { round: g.round, value: g.toss.value, tiebreak: !!only });
  setClock(room, 'tossTick', TOSS_FIRST_MS);
}

function tossTick(room) {
  const g = room.game, t = g.toss;
  if (g.phase !== 'toss') return;
  const next = t.order.find(k => !g.open[k]);
  if (next == null) return setClock(room, 'tossDead', TOSS_GRACE_MS);
  g.open[next] = true;
  fx(room, 'tossLetter', { cell: g.puz.cells[next].i });
  if (!hiddenLeft(g)) setClock(room, 'tossDead', TOSS_GRACE_MS);
  else setClock(room, 'tossTick', TOSS_TICK_MS);
}

const tossIn = (room, id) => { const t = room.game.toss; return !t.out.includes(id) && (!t.only || t.only.includes(id)); };

function tossBuzz(room, p) {
  const g = room.game;
  if (!g || g.phase !== 'toss' || !room.order.includes(p.id) || !tossIn(room, p.id)) return false;
  snapshot(room);
  g.phase = 'tossAnswer'; g.toss.buzzed = p.id; g.toss.guess = null;
  fx(room, 'buzz', { name: p.name, id: p.id });
  setClock(room, 'tossAnswer', TOSS_ANSWER_SECS * 1000);
  return true;
}

function tossGuess(room, p, text) {
  const g = room.game, t = g && g.toss;
  if (!t || g.phase !== 'tossAnswer' || t.buzzed !== p.id) return;
  snapshot(room);
  t.guess = clean(text, 60).toUpperCase();
  if (Board.matches(text, g.puz.text)) tossOver(room, p.id);
  else tossWrong(room, false);
}

function tossWrong(room, timedOut) {
  const g = room.game, t = g.toss;
  const pid = t.buzzed;
  t.out.push(pid); t.buzzed = null;
  fx(room, 'tossWrong', { name: pname(room, pid), guess: timedOut ? null : t.guess, time: !!timedOut });
  const left = contestants(room).filter(id => tossIn(room, id));
  if (!left.length) return tossOver(room, null);
  g.phase = 'toss';
  setClock(room, hiddenLeft(g) ? 'tossTick' : 'tossDead', hiddenLeft(g) ? TOSS_TICK_MS : TOSS_GRACE_MS);
}

function tossOver(room, pid) {
  const g = room.game, t = g.toss;
  openAll(g);
  g.phase = 'tossWon'; t.winner = pid; t.buzzed = null;
  if (pid) {
    g.total[pid] += t.value;
    const st = stat(room, pid); if (st) st.tosses++;
  }
  fx(room, pid ? 'tossRight' : 'tossNobody', { name: pid ? pname(room, pid) : null, value: t.value });
  setClock(room, 'afterToss', AFTER_TOSS_MS);
}

function afterToss(room) {
  const g = room.game, t = g.toss;
  if (t.only) {                                    // a tiebreaker for the bonus round
    if (t.winner) return startBonus(room, t.winner);
    return startToss(room, t.only);                // nobody got it: another one
  }
  const ids = contestants(room);
  let first = t.winner;
  if (!first || !ids.includes(first)) {
    // Nobody got the toss-up: the turn goes round, starting after whoever began the last round.
    const i = ids.indexOf(g.starter);
    first = ids[(i + 1) % ids.length];
  }
  startRound(room, first);
}

/* -------- a round: spin, call a consonant, buy a vowel, or solve */

function startRound(room, first) {
  const g = room.game;
  g.kind = 'round';
  setPuzzle(g, drawPuzzle(room, 'round'));
  for (const id of contestants(room)) g.bank[id] = 0;
  g.control = first; g.starter = first; g.last = null; g.toss = null; g.solvedBy = null;
  g.wheel = { kind: wheelFor(g.round, g.rounds), angle: g.wheel.angle % 360, from: g.wheel.angle % 360, at: 0, dur: 0, idx: null };
  g.phase = 'turn';
  g.clock = null;
  fx(room, 'round', { round: g.round, rounds: g.rounds, name: pname(room, first), top: WHEELS[g.wheel.kind][0] });
}

function spin(room, pid, power, kind) {
  const g = room.game;
  const pw = Math.max(0, Math.min(1, Number(power) || 0));
  const from = g.wheel.angle % 360;
  const to = from + 720 + pw * 1080 + crypto.randomInt(3600) / 10;
  const dur = Math.round((4000 + pw * 2400) / SPEED);
  g.wheel = { kind, angle: to, from, at: Date.now(), dur, idx: wedgeAt(to) };
  fx(room, 'spin', { name: pname(room, pid) });
}

function doSpin(room, p, power) {
  const g = room.game;
  if (!g || g.phase !== 'turn' || g.control !== p.id || !consLeft(g)) return;
  snapshot(room);
  spin(room, p.id, power, g.wheel.kind);
  g.phase = 'spinning'; g.last = null;
  setClock(room, 'land', (g.wheel.dur + 300) * SPEED);
}

function land(room) {
  const g = room.game;
  const w = WHEELS[g.wheel.kind][g.wheel.idx];
  const pid = g.control, st = stat(room, pid);
  if (w === 'BK') {
    if (st) st.bankrupts++;
    g.last = { pid, type: 'bankrupt', lost: g.bank[pid] };
    g.bank[pid] = 0;
    g.phase = 'pause';
    fx(room, 'bankrupt', { name: pname(room, pid) });
    return setClock(room, 'next', PAUSE_MS + 600);
  }
  if (w === 'LT') {
    if (st) st.lost++;
    g.last = { pid, type: 'loseTurn' };
    g.phase = 'pause';
    fx(room, 'loseTurn', { name: pname(room, pid) });
    return setClock(room, 'next', PAUSE_MS + 400);
  }
  g.last = { pid, type: 'landed', value: w };
  g.phase = 'call';
  fx(room, 'landed', { name: pname(room, pid), value: w });
  if (room.settings.letterSecs) setClock(room, 'call', room.settings.letterSecs * 1000);
  else g.clock = null;
}

function callLetter(room, p, letter) {
  const g = room.game;
  const L = String(letter || '').toUpperCase();
  if (!g || g.phase !== 'call' || g.control !== p.id || !/^[A-Z]$/.test(L) || Board.isVowel(L)) return;
  snapshot(room);
  stopClock(room);
  const value = WHEELS[g.wheel.kind][g.wheel.idx];
  reveal(room, p.id, L, value);
}

function buyVowel(room, p, letter) {
  const g = room.game;
  const L = String(letter || '').toUpperCase();
  if (!g || g.phase !== 'turn' || g.control !== p.id || !Board.isVowel(L) || g.bank[p.id] < VOWEL_COST || !vowelsLeft(g)) return;
  snapshot(room);
  g.bank[p.id] -= VOWEL_COST;
  const st = stat(room, p.id); if (st) st.vowels++;
  reveal(room, p.id, L, 0);
}

// A letter is called (a consonant after a spin, or a bought vowel).
function reveal(room, pid, L, value) {
  const g = room.game, st = stat(room, pid);
  const again = g.called.includes(L);
  const cells = again ? [] : cellsOf(g, L);
  if (!again) g.called.push(L);
  if (!cells.length) {
    if (st) st.misses++;
    g.last = { pid, type: 'miss', letter: L, again };
    g.phase = 'pause';
    fx(room, 'miss', { name: pname(room, pid), letter: L, again });
    return setClock(room, 'next', PAUSE_MS);
  }
  for (const k of cells) g.open[k] = true;
  const won = value * cells.length;
  g.bank[pid] += won;
  if (st && value) { st.hits++; st.letterCash += won; if (won > st.best) st.best = won; }
  g.last = { pid, type: 'hit', letter: L, count: cells.length, value, won };
  g.phase = 'lighting';
  fx(room, 'letter', { name: pname(room, pid), letter: L, count: cells.length, value, won, cells: cells.map(k => g.puz.cells[k].i) });
  setClock(room, 'lit', 500 + cells.length * LETTER_MS);
}

function miss(room, why) {
  const g = room.game, pid = g.control, st = stat(room, pid);
  if (st) st.misses++;
  g.last = { pid, type: why === 'time' ? 'time' : 'wrongSolve', guess: g.guess || null };
  g.phase = 'pause';
  fx(room, why === 'time' ? 'timeUp' : 'wrongSolve', { name: pname(room, pid), guess: g.guess || null });
  g.guess = null;
  setClock(room, 'next', why === 'time' ? PAUSE_MS : PAUSE_MS + 900);
}

function startSolve(room, p) {
  const g = room.game;
  if (!g || g.phase !== 'turn' || g.control !== p.id) return;
  snapshot(room);
  g.phase = 'solve'; g.guess = null; g.last = null;
  fx(room, 'solving', { name: p.name });
  setClock(room, 'solve', SOLVE_SECS * 1000);
}

function cancelSolve(room, p) {
  const g = room.game;
  if (!g || g.phase !== 'solve' || g.control !== p.id) return;
  stopClock(room);
  g.phase = 'turn';
}

function solveGuess(room, p, text) {
  const g = room.game;
  if (!g || g.phase !== 'solve' || g.control !== p.id) return;
  snapshot(room);
  stopClock(room);
  g.guess = clean(text, 60).toUpperCase();
  if (Board.matches(text, g.puz.text)) solved(room, p.id);
  else miss(room, 'wrong');
}

function solved(room, pid) {
  const g = room.game;
  openAll(g);
  const won = Math.max(g.bank[pid], HOUSE_MIN);
  g.total[pid] += won;
  for (const id of Object.keys(g.bank)) g.bank[id] = 0;
  const st = stat(room, pid); if (st) { st.solves++; st.roundCash += won; }
  g.solvedBy = pid; g.last = { pid, type: 'solved', won };
  g.phase = 'solved'; g.guess = null;
  fx(room, 'solved', { name: pname(room, pid), won, round: g.round });
  setClock(room, 'afterSolve', AFTER_SOLVE_MS);
}

function nextTurn(room) {
  const g = room.game;
  const ids = contestants(room);
  if (!ids.length) return;
  const i = ids.indexOf(g.control);
  g.control = ids[(i + 1) % ids.length];
  g.phase = 'turn'; g.last = null; g.guess = null;
  stopClock(room);
  fx(room, 'turn', { name: pname(room, g.control) });
}

function afterRound(room) {
  const g = room.game;
  if (g.round < g.rounds) { g.round++; return startToss(room, null); }
  toBonus(room);
}

/* -------- the bonus round */

function toBonus(room) {
  const g = room.game, ids = contestants(room);
  if (!ids.length) return endGame(room);
  let top = -Infinity;
  for (const id of ids) top = Math.max(top, g.total[id]);
  const leaders = ids.filter(id => g.total[id] === top);
  if (!room.settings.bonus || top <= 0) return endGame(room);
  if (leaders.length > 1) { g.round++; return startToss(room, leaders); }   // a tiebreaker toss-up first
  startBonus(room, leaders[0]);
}

function startBonus(room, pid) {
  const g = room.game;
  g.kind = 'bonus'; g.control = pid; g.toss = null; g.last = null; g.solvedBy = null;
  g.puz = null; g.open = []; g.called = [];
  g.bonus = { pid, picks: [], prize: null, solved: null, guesses: [] };
  g.wheel = { kind: 'bonus', angle: g.wheel.angle % 360, from: g.wheel.angle % 360, at: 0, dur: 0, idx: null };
  g.phase = 'bonusSpin';
  stopClock(room);
  fx(room, 'bonus', { name: pname(room, pid) });
}

function bonusSpin(room, p, power) {
  const g = room.game;
  if (!g || g.phase !== 'bonusSpin' || g.bonus.pid !== p.id) return;
  spin(room, p.id, power, 'bonus');
  g.phase = 'bonusSpinning';
  setClock(room, 'bonusLand', (g.wheel.dur + 300) * SPEED);
}

function bonusLanded(room) {
  const g = room.game;
  g.bonus.prize = WHEELS.bonus[g.wheel.idx];     // sealed in the envelope until the end
  setPuzzle(g, drawPuzzle(room, 'bonus'));
  const cells = [];
  for (const L of BONUS_GIVEN) { g.called.push(L); for (const k of cellsOf(g, L)) { g.open[k] = true; cells.push(g.puz.cells[k].i); } }
  g.phase = 'bonusLighting';
  fx(room, 'bonusGiven', { cells });
  setClock(room, 'bonusGiven', 1800 + cells.length * 350);
}

function autoPicks(g) {
  const out = [];
  for (const L of 'CDMPGHBA') {
    if (out.length < 4 && !g.called.includes(L) && !out.includes(L)) {
      const vowels = out.filter(Board.isVowel).length, cons = out.length - vowels;
      if (Board.isVowel(L) ? vowels < 1 : cons < 3) out.push(L);
    }
  }
  return out;
}

function bonusPicks(room, letters) {
  const g = room.game;
  if (!g || g.phase !== 'bonusPick') return;
  const picks = [...new Set((Array.isArray(letters) ? letters : []).map(l => String(l).toUpperCase()))].filter(l => /^[A-Z]$/.test(l) && !g.called.includes(l));
  if (picks.filter(Board.isVowel).length !== 1 || picks.filter(l => !Board.isVowel(l)).length !== 3) return;
  stopClock(room);
  g.bonus.picks = picks;
  const cells = [];
  for (const L of picks) { g.called.push(L); for (const k of cellsOf(g, L)) { g.open[k] = true; cells.push(g.puz.cells[k].i); } }
  g.phase = 'bonusLighting';
  fx(room, 'bonusPicks', { picks, cells });
  setClock(room, 'bonusLit', 1600 + cells.length * 450);
}

function bonusGuess(room, p, text) {
  const g = room.game;
  if (!g || g.phase !== 'bonusSolve' || g.bonus.pid !== p.id) return;
  const guess = clean(text, 60).toUpperCase();
  if (!guess) return;
  g.bonus.guesses.push(guess);
  if (g.bonus.guesses.length > 20) g.bonus.guesses.shift();
  if (Board.matches(text, g.puz.text)) bonusOver(room, true);
  else fx(room, 'bonusWrong', { guess });
}

function bonusOver(room, won) {
  const g = room.game, b = g.bonus;
  stopClock(room);
  openAll(g);
  b.solved = won;
  if (won) { g.total[b.pid] += b.prize; const st = stat(room, b.pid); if (st) st.solves++; g.solvedBy = b.pid; }
  g.phase = 'bonusDone';
  fx(room, won ? 'bonusWin' : 'bonusLose', { name: pname(room, b.pid), prize: b.prize });
  setClock(room, 'afterBonus', 9000);
}

function endGame(room) {
  const g = room.game;
  stopClock(room);
  g.phase = 'gameOver';
  const ids = contestants(room);
  let top = -Infinity;
  for (const id of ids) top = Math.max(top, g.total[id]);
  g.winner = top > 0 ? ids.filter(id => g.total[id] === top) : [];
  fx(room, 'win', { names: g.winner.map(id => pname(room, id)), tie: g.winner.length > 1 });
}

/* -------- a phone dropped out in the middle of its turn */

function skipIdle(room) {
  const g = room.game;
  if (!g || !['turn', 'call', 'solve'].includes(g.phase)) return false;
  const p = room.players.get(g.control);
  if (!p || p.connected || !p.goneAt || Date.now() - p.goneAt < IDLE_SKIP_MS) return false;
  fx(room, 'skipped', { name: p.name });
  nextTurn(room);
  return true;
}

/* ------------------------------------------------- host and captain actions */

// The clock a phase starts with, for when it's restored by Undo.
function freshClock(room) {
  const g = room.game;
  g.clock = null;
  if (g.phase === 'toss') setClock(room, 'tossTick', TOSS_TICK_MS);
  else if (g.phase === 'tossAnswer') setClock(room, 'tossAnswer', TOSS_ANSWER_SECS * 1000);
  else if (g.phase === 'call' && room.settings.letterSecs) setClock(room, 'call', room.settings.letterSecs * 1000);
  else if (g.phase === 'solve') setClock(room, 'solve', SOLVE_SECS * 1000);
  else if (g.phase === 'bonusPick') setClock(room, 'bonusPick', BONUS_PICK_SECS * 1000);
  else if (g.phase === 'bonusSolve') setClock(room, 'bonusSolve', BONUS_SECS * 1000);
  else armTimer(room);
}

function hostAction(room, p, m) {
  const g = room.game;
  const isHost = p.isHost, isCaptain = captainId(room) === p.id;
  if (!isHost && !isCaptain) return;
  // Lobby and between-games controls: the host, or the captain when there is no host.
  switch (m.a) {
    case 'start': if (!g) startGame(room); return;
    case 'settings':
      if (g) return;
      if (typeof m.useCustom === 'boolean') room.settings.useCustom = m.useCustom;
      if (typeof m.bonus === 'boolean') room.settings.bonus = m.bonus;
      if (ROUND_CHOICES.includes(m.rounds)) room.settings.rounds = m.rounds;
      if (LETTER_CHOICES.includes(m.letterSecs)) room.settings.letterSecs = m.letterSecs;
      if (Array.isArray(m.packs)) room.settings.packs = packIds().filter(id => m.packs.includes(id));
      return;
    case 'custom': if (!g) room.custom = cleanCustom(m.custom); return;
    case 'kick': {
      const x = room.players.get(m.id);
      if (x && !x.isHost && x !== p) dropPlayer(room, x, true);
      return;
    }
    case 'lobby':                                  // back to the lobby: after a game, or to end one early
      if (g && (g.phase === 'gameOver' || isHost)) { stopClock(room); room.game = null; room.history = []; fx(room, 'lobby'); }
      return;
  }
  if (!isHost || !g) return;
  // Mid-game fixes: the host only.
  switch (m.a) {
    case 'undo':
      if (room.history.length) {
        room.game = JSON.parse(room.history.pop());
        freshClock(room);
        fx(room, 'undo');
      }
      break;
    case 'skipTurn':                               // pass the turn on (someone is stuck)
      if (['turn', 'call', 'solve', 'pause'].includes(g.phase)) { snapshot(room); nextTurn(room); }
      break;
    case 'giveTurn':
      if (['turn', 'call', 'solve', 'pause'].includes(g.phase) && room.order.includes(m.id)) { snapshot(room); g.control = m.id; g.phase = 'turn'; g.last = null; stopClock(room); fx(room, 'turn', { name: pname(room, m.id) }); }
      break;
    case 'adjust': {                               // fix a score
      const id = m.id, d = Math.round(Number(m.delta));
      if (!room.order.includes(id) || !Number.isFinite(d)) break;
      snapshot(room);
      if (m.field === 'bank') g.bank[id] = Math.max(0, (g.bank[id] || 0) + d);
      else g.total[id] = (g.total[id] || 0) + d;
      break;
    }
    case 'solveFor':                               // a typo the game didn't accept: count it
      if (!room.order.includes(m.id)) break;
      if (g.kind === 'round' && ['turn', 'call', 'solve', 'pause', 'lighting'].includes(g.phase)) { snapshot(room); stopClock(room); g.control = m.id; solved(room, m.id); }
      else if (g.kind === 'toss' && ['toss', 'tossAnswer'].includes(g.phase)) { snapshot(room); stopClock(room); tossOver(room, m.id); }
      else if (g.kind === 'bonus' && g.phase === 'bonusSolve' && m.id === g.bonus.pid) { snapshot(room); bonusOver(room, true); }
      break;
    case 'nobody':                                 // give up on this puzzle: nobody wins it
      if (g.kind === 'round' && ['turn', 'call', 'solve', 'pause'].includes(g.phase)) {
        snapshot(room); stopClock(room); openAll(g);
        for (const id of Object.keys(g.bank)) g.bank[id] = 0;
        g.solvedBy = null; g.last = { type: 'nobody' }; g.phase = 'solved';
        fx(room, 'nobody');
        setClock(room, 'afterSolve', AFTER_SOLVE_MS);
      } else if (g.kind === 'toss' && ['toss', 'tossAnswer'].includes(g.phase)) { snapshot(room); stopClock(room); tossOver(room, null); }
      break;
    case 'endGame':                                // straight to the final scores
      if (g.phase !== 'gameOver') { snapshot(room); endGame(room); }
      break;
  }
}

/* ----------------------------------------------------------------- state */

const money = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
const wedgeLabel = w => (w === 'BK' ? 'BANKRUPT' : w === 'LT' ? 'LOSE A TURN' : w);

// The board as the screens see it: 56 tiles, '' for an empty tile, '.' for a hidden letter.
function boardView(g) {
  const out = new Array(Board.COLS * Board.ROWS).fill('');
  if (!g.puz) return out;
  g.puz.cells.forEach((c, k) => { out[c.i] = g.open[k] ? c.ch : '.'; });
  return out;
}

function publicState(room) {
  const g = room.game;
  const pl = id => { const p = room.players.get(id); return p ? { id: p.id, name: p.name, on: p.connected } : null; };
  const s = {
    code: room.code,
    phase: g ? g.phase : 'lobby',
    players: contestants(room).map(pl).filter(Boolean),
    host: room.hostId ? pl(room.hostId) : null,
    captain: captainId(room),
    settings: room.settings,
    packs: BANK.packs.map(p => ({ id: p.id, name: p.name, blurb: p.blurb, adult: !!p.adult, count: p.count })),
    customCount: room.custom.puzzles.length,
    maxPlayers: MAX_PLAYERS, roundChoices: ROUND_CHOICES, letterChoices: LETTER_CHOICES,
    vowelCost: VOWEL_COST, bonusGiven: BONUS_GIVEN,
    fx: room.fx,
    game: null
  };
  if (g) {
    const over = ['tossWon', 'solved', 'bonusDone', 'gameOver'].includes(g.phase);
    const isBonus = g.wheel.kind === 'bonus';
    s.game = {
      round: g.round, rounds: g.rounds, kind: g.kind,
      cat: g.puz ? g.puz.cat : null, pack: g.puz ? packName(g.puz.pack) : null,
      board: boardView(g), called: g.called,
      answer: over && g.puz ? g.puz.text : null,
      control: g.control, bank: g.bank, total: g.total,
      consLeft: g.puz ? consLeft(g) : false, vowelsLeft: g.puz ? vowelsLeft(g) : false, hidden: g.puz ? hiddenLeft(g) : false,
      wheel: {
        kind: g.wheel.kind, angle: g.wheel.angle, from: g.wheel.from, dur: g.wheel.dur,
        elapsed: g.wheel.at ? Date.now() - g.wheel.at : null,
        // The bonus envelopes stay sealed until the end.
        wedges: WHEELS[g.wheel.kind].map(w => (isBonus ? (g.phase === 'bonusDone' || g.phase === 'gameOver' ? w : '?') : wedgeLabel(w))),
        idx: g.phase === 'spinning' || g.phase === 'bonusSpinning' ? null : g.wheel.idx
      },
      landed: g.phase === 'call' ? WHEELS[g.wheel.kind][g.wheel.idx] : null,
      clock: g.clock ? { what: g.clock.what, left: Math.max(0, g.clock.at - Date.now()), len: g.clock.len } : null,
      last: g.last, guess: g.guess || null, solvedBy: g.solvedBy,
      toss: g.toss ? { value: g.toss.value, buzzed: g.toss.buzzed, out: g.toss.out, only: g.toss.only, winner: g.toss.winner, guess: g.toss.guess } : null,
      bonus: g.bonus ? { pid: g.bonus.pid, picks: g.bonus.picks, guesses: g.bonus.guesses, solved: g.bonus.solved, prize: g.phase === 'bonusDone' || g.phase === 'gameOver' ? g.bonus.prize : null } : null,
      winner: g.winner,
      awards: g.phase === 'gameOver' ? awards(room) : null
    };
  }
  return s;
}

function stateFor(room, pub, p) {
  const s = Object.assign({}, pub);
  const g = room.game;
  const playing = room.order.includes(p.id);
  s.me = { id: p.id, name: p.name, isHost: p.isHost, isCaptain: pub.captain === p.id, playing };
  if (p.isHost) s.hostView = { canUndo: room.history.length > 0, answer: g && g.puz ? g.puz.text : null, custom: room.custom };
  if (g && playing) {
    s.me.total = g.total[p.id];
    s.me.bank = g.bank[p.id];
    s.me.myTurn = g.control === p.id && ['turn', 'spinning', 'call', 'lighting', 'pause', 'solve'].includes(g.phase);
    s.me.canBuzz = g.phase === 'toss' && !!g.toss && tossIn(room, p.id);
    s.me.tossOut = !!g.toss && !tossIn(room, p.id);
    s.me.bonus = !!g.bonus && g.bonus.pid === p.id;
    if (g.phase === 'gameOver') {
      const st = (g.stats && g.stats[p.id]) || {};
      s.me.stats = { hits: st.hits || 0, misses: st.misses || 0, letterCash: st.letterCash || 0, best: st.best || 0, bankrupts: st.bankrupts || 0, solves: st.solves || 0, tosses: st.tosses || 0 };
      s.me.awards = (pub.game.awards || []).filter(a => a.id === p.id).map(a => a.key);
    }
  }
  return s;
}

function awards(room) {
  const g = room.game;
  const rows = Object.keys(g.stats || {}).map(id => { const p = room.players.get(id); return p && room.order.includes(id) ? { id, name: p.name, s: g.stats[id] } : null; }).filter(Boolean);
  const out = [];
  const solver = rows.filter(r => r.s.solves + r.s.tosses > 0).sort((a, b) => (b.s.solves + b.s.tosses) - (a.s.solves + a.s.tosses))[0];
  if (solver) out.push({ key: 'solver', title: 'MOST SOLVES', id: solver.id, name: solver.name, note: (solver.s.solves + solver.s.tosses) + ' puzzle' + (solver.s.solves + solver.s.tosses === 1 ? '' : 's') });
  const caller = rows.filter(r => r.s.hits > 0).sort((a, b) => b.s.hits - a.s.hits || a.s.misses - b.s.misses)[0];
  if (caller) out.push({ key: 'caller', title: 'BEST LETTER CALLER', id: caller.id, name: caller.name, note: caller.s.hits + ' good letter' + (caller.s.hits === 1 ? '' : 's') + ' · ' + money(caller.s.letterCash) });
  const big = rows.filter(r => r.s.best > 0).sort((a, b) => b.s.best - a.s.best)[0];
  if (big) out.push({ key: 'big', title: 'BIGGEST SINGLE CALL', id: big.id, name: big.name, note: money(big.s.best) });
  const bk = rows.filter(r => r.s.bankrupts > 0).sort((a, b) => b.s.bankrupts - a.s.bankrupts)[0];
  if (bk) out.push({ key: 'bankrupt', title: 'BANKRUPT MAGNET', id: bk.id, name: bk.name, note: bk.s.bankrupts + ' bankrupt' + (bk.s.bankrupts === 1 ? '' : 's') });
  return out.slice(0, 4);
}

function pushAll(room) {
  room.touched = Date.now();
  const pub = publicState(room);
  if (room.displays.size) {
    const d = JSON.stringify({ t: 'state', s: Object.assign({}, pub, { display: true, used: [...room.used] }) });
    for (const ws of room.displays) if (ws.readyState === 1) ws.send(d);
  }
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'state', s: stateFor(room, pub, p) }));
  }
  queueBackup(room);
}

/* -------------------------------------------------------------- messages */

function dropPlayer(room, p, kicked) {
  const g = room.game;
  const wasTurn = g && g.control === p.id;
  const i = room.order.indexOf(p.id);
  if (i >= 0) room.order.splice(i, 1);
  if (room.hostId === p.id) room.hostId = null;
  room.players.delete(p.id);
  if (g) {
    if (!room.order.length) { stopClock(room); room.game = null; room.history = []; fx(room, 'lobby'); }
    else {
      if (g.toss && g.toss.buzzed === p.id) { g.toss.buzzed = null; g.phase = 'toss'; setClock(room, 'tossTick', TOSS_TICK_MS); }
      if (g.toss && g.toss.only) g.toss.only = g.toss.only.filter(id => id !== p.id);
      if (g.bonus && g.bonus.pid === p.id) endGame(room);
      else if (wasTurn && g.kind === 'round' && g.phase !== 'solved') {
        // the turn moves to whoever sits next
        const ids = room.order;
        g.control = ids[Math.min(i, ids.length - 1)] || ids[0];
        g.phase = 'turn'; g.last = null; stopClock(room);
      }
      if (g.starter === p.id) g.starter = room.order[0];
    }
  }
  if (p.ws) {
    send(p.ws, { t: 'left', kicked: !!kicked });
    p.ws.room = null; p.ws.pid = null;
  }
}

function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) {
    send(p.ws, { t: 'left', replaced: true });
    p.ws.room = null; p.ws.pid = null;
    try { p.ws.close(); } catch (e) { /* ignore */ }
  }
  p.ws = ws; p.connected = true; p.hold = 0; p.goneAt = 0;
  ws.room = room; ws.pid = p.id;
}

const justStarted = () => Date.now() - BOOT < RESTORE_WINDOW_MS;

function showOn(ws, room, admin) {
  if (ws.display && ws.room && ws.room !== room) ws.room.displays.delete(ws);
  ws.room = room; ws.display = true; ws.admin = admin;
  room.displays.add(ws);
}

function onMessage(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'ping') return;

  if (m.t === 'create') {
    const room = newRoom();
    if (Array.isArray(m.used)) for (const id of m.used.slice(-3000)) if (typeof id === 'string' && id) room.used.add(id.slice(0, 160));
    room.custom = cleanCustom(m.custom);
    showOn(ws, room, true);
    send(ws, { t: 'created', code: room.code, token: room.adminToken });
    return pushAll(room);
  }

  if (m.t === 'watch' || m.t === 'restore') {
    const code = clean(m.code, 4).toUpperCase();
    let room = rooms.get(code), restored = false;
    if (!room && m.t === 'restore' && typeof m.blob === 'string' && m.blob.length <= BACKUP_MAX) {
      room = restoreRoom(m.blob, code, m.token, m.idle);
      restored = !!room;
    }
    if (!room) return send(ws, { t: 'error', code: 'noroom', msg: 'That game is no longer running.', wait: m.t === 'watch' && justStarted() });
    showOn(ws, room, m.token === room.adminToken);
    send(ws, { t: 'watching', code: room.code, admin: ws.admin, restored });
    return pushAll(room);
  }

  if (m.t === 'join') {
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    if (!room) return send(ws, { t: 'error', code: 'noroom', msg: "Can't find that room. Check the 4-letter code on the TV.", wait: justStarted() });
    const name = clean(m.name, 12).toUpperCase();
    if (!name) return send(ws, { t: 'error', msg: 'Enter your name.' });
    let p = [...room.players.values()].find(x => x.name === name);
    if (p) {
      if (p.connected) return send(ws, { t: 'error', msg: 'Someone is already playing as ' + name + '. Pick another name.' });
      if (p.hold && Date.now() < p.hold) return send(ws, { t: 'error', msg: name + ' is still reconnecting. Try again in a few seconds, or pick another name.' });
      p.token = rid();
    } else {
      if (room.players.size >= MAX_PLAYERS + 1) return send(ws, { t: 'error', msg: 'This room is full: ' + MAX_PLAYERS + ' players and a host.' });
      p = { id: rid(6), token: rid(), name, isHost: false, connected: true, ws: null };
      room.players.set(p.id, p);
    }
    attach(ws, room, p);
    send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id });
    return pushAll(room);
  }

  if (m.t === 'rejoin') {
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    const p = room && [...room.players.values()].find(x => x.token === m.token);
    if (!p) return send(ws, { t: 'error', code: 'noroom', msg: 'That game has ended.', wait: !room && justStarted() });
    attach(ws, room, p);
    send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id });
    return pushAll(room);
  }

  const room = ws.room;
  if (!room) return;

  if (ws.display) {
    if (m.t === 'custom' && ws.admin && !room.game) { room.custom = cleanCustom(m.custom); pushAll(room); }
    return;
  }

  const p = room.players.get(ws.pid);
  if (!p) return;
  const g = room.game;

  switch (m.t) {
    case 'play':                                   // join the game as a player (or step out, between games)
      if (m.on) {
        if (g) break;
        if (p.isHost) { p.isHost = false; room.hostId = null; }
        if (!room.order.includes(p.id)) { if (room.order.length >= MAX_PLAYERS) { send(ws, { t: 'error', msg: 'All ' + MAX_PLAYERS + ' spots are taken.' }); break; } room.order.push(p.id); }
      } else if (!g) {
        const i = room.order.indexOf(p.id); if (i >= 0) room.order.splice(i, 1);
      }
      break;
    case 'host': {
      if (m.on) {
        const cur = room.hostId && room.players.get(room.hostId);
        if (cur && cur.id !== p.id && cur.connected) { send(ws, { t: 'error', msg: cur.name + ' is already the host.' }); break; }
        if (g && room.order.includes(p.id)) break;           // a player can't switch to hosting mid-game
        if (cur) cur.isHost = false;
        const i = room.order.indexOf(p.id); if (i >= 0) room.order.splice(i, 1);
        p.isHost = true; room.hostId = p.id;
      } else if (p.isHost && !g) { p.isHost = false; room.hostId = null; }
      break;
    }
    case 'spin':
      if (g && g.phase === 'turn') doSpin(room, p, m.power);
      else if (g && g.phase === 'bonusSpin') bonusSpin(room, p, m.power);
      break;
    case 'call': callLetter(room, p, m.letter); break;
    case 'vowel': buyVowel(room, p, m.letter); break;
    case 'solve': startSolve(room, p); break;
    case 'cancelSolve': cancelSolve(room, p); break;
    case 'guess':
      if (!g) break;
      if (g.phase === 'tossAnswer') tossGuess(room, p, m.text);
      else if (g.phase === 'solve') solveGuess(room, p, m.text);
      else if (g.phase === 'bonusSolve') bonusGuess(room, p, m.text);
      break;
    case 'buzz': if (!tossBuzz(room, p)) return; break;
    case 'picks': if (g && g.bonus && g.bonus.pid === p.id) bonusPicks(room, m.letters); break;
    case 'leave': dropPlayer(room, p, false); break;
    case 'h': hostAction(room, p, m); break;
    default: return;
  }
  pushAll(room);
}

function onClose(ws) {
  const room = ws.room;
  if (!room) return;
  if (ws.display) { room.displays.delete(ws); return; }
  const p = room.players.get(ws.pid);
  if (p && p.ws === ws) {
    p.connected = false; p.ws = null; p.goneAt = Date.now();
    if (!room.game && !room.order.includes(p.id) && !p.isHost) room.players.delete(p.id);
    pushAll(room);
  }
}

/* ------------------------------------------------------------- websocket */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    try { onMessage(ws, m); } catch (e) { console.error('message error', e); }
  });
  ws.on('close', () => { try { onClose(ws); } catch (e) { console.error('close error', e); } });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS) { clearTimer(room); clearTimeout(room.backupTimer); clearTimeout(room.tidyTimer); rooms.delete(code); }
  }
}, 30000).unref();

setInterval(() => {
  for (const room of rooms.values()) if (skipIdle(room)) pushAll(room);
}, 4000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log('Friend Wheel server running on port ' + PORT));
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    for (const room of rooms.values()) { try { clearTimeout(room.backupTimer); room.backupTimer = null; sendBackup(room); } catch (e) { /* keep going */ } }
    setTimeout(() => process.exit(0), 400);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { server, rooms, packRoom, unpackRoom, restoreRoom, WHEELS, wedgeAt };
