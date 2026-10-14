'use strict';
/*
 * Plays a whole game against a real server with scripted screens: a TV, a host phone and three
 * player phones. Checks the rules along the way (toss-ups, spins, letters, vowels, solving, the
 * bonus round), every built-in puzzle, and that a game comes back after the server forgets it.
 * The clocks run 8 times faster than in a real game.   Run with: npm test
 */
process.env.RESTORE_WINDOW_MS = '600000';
process.env.SPEED_UP = '8';
const WebSocket = require('ws');
const Board = require('../board');
const BANK = require('../puzzles');
const { server, rooms, WHEELS, wedgeAt } = require('../server');

const PORT = 3998;
let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

class Screen {
  constructor(name) {
    this.name = name; this.state = null; this.msgs = []; this.last = {};
    this.ws = new WebSocket('ws://localhost:' + PORT + '/ws');
    this.ready = new Promise(res => this.ws.on('open', res));
    this.ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'state') this.state = m.s;
      this.last[m.t] = m;
      this.msgs.push(m);
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async until(fn, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn(this.state, this.last)) return true; } catch (e) { /* not there yet */ } await wait(10); }
    return false;
  }
  close() { this.ws.close(); }
}

async function main() {
  // ---- every built-in puzzle fits the board
  let bad = BANK.puzzles.filter(p => Board.layout(p.text).err);
  check('all ' + BANK.puzzles.length + ' built-in puzzles fit the board', !bad.length, bad.map(p => p.text).join(', '));
  check('wedge under the pointer', wedgeAt(0) === 0 && wedgeAt(10) === 23 && wedgeAt(-20 + 360) === 1 && wedgeAt(355) === 0);
  check('typo forgiveness', Board.matches('peanut buter and jelly sandwich', 'PEANUT BUTTER AND JELLY SANDWICH') && !Board.matches('break a log', 'BREAK A LEG') && Board.matches("dont count your chickens", "DON'T COUNT YOUR CHICKENS"));

  await new Promise(res => server.listen(PORT, res));
  console.log('server up on ' + PORT);

  // ---- lobby
  const tv = new Screen('tv'); await tv.ready;
  tv.send({ t: 'create', used: [], custom: { puzzles: [{ cat: 'INSIDE JOKE', text: 'THE TACO TRUCK INCIDENT' }, { cat: 'BAD', text: 'THIS ONE IS WAY TOO LONG TO EVER FIT ON THE BOARD AT ALL SORRY' }] } });
  check('room created', await tv.until((s, l) => l.created && s));
  const code = tv.last.created.code, token = tv.last.created.token;
  check('a puzzle that does not fit is dropped', tv.state.customCount === 1);
  const host = new Screen('host'); await host.ready;
  host.send({ t: 'join', code, name: 'Hosty' });
  const ps = [];
  for (const n of ['Ann', 'Ben', 'Cal']) { const p = new Screen(n); await p.ready; p.send({ t: 'join', code, name: n }); ps.push(p); }
  for (const p of [host, ...ps]) check(p.name + ' joined', await p.until((s, l) => l.joined && s));
  const [ann, ben, cal] = ps;
  for (const p of ps) p.send({ t: 'play', on: true });
  check('three players, no host yet: Ann is captain', await tv.until(s => s.players.length === 3 && s.captain === s.players[0].id));
  host.send({ t: 'host', on: true });
  check('a host takes over the lobby', await tv.until(s => s.host && s.host.name === 'HOSTY' && s.captain === null));
  ann.send({ t: 'h', a: 'settings', rounds: 4 });
  await wait(80);
  check('a player cannot change settings when there is a host', tv.state.settings.rounds === 3);
  host.send({ t: 'h', a: 'settings', rounds: 2, letterSecs: 10, packs: BANK.packs.map(p => p.id), useCustom: false });
  check('settings applied', await host.until(s => s.settings.rounds === 2 && s.settings.letterSecs === 10 && s.settings.packs.length === BANK.packs.length));

  const id = p => p.state.me.id;
  const answer = () => host.state.hostView.answer;
  const G = () => host.state.game;

  // ---- toss-up 1
  host.send({ t: 'h', a: 'start' });
  check('game starts with a toss-up', await tv.until(s => s.phase === 'toss' && s.game.toss.value === 1000));
  check('letters come up one at a time', await tv.until(s => s.game.board.some(c => /[A-Z]/.test(c)), 3000));
  check('the answer is not in the TV state', !JSON.stringify(tv.state).includes(answer()));
  ben.send({ t: 'buzz' });
  check('Ben buzzes in', await tv.until(s => s.phase === 'tossAnswer' && s.game.toss.buzzed === id(ben)));
  ann.send({ t: 'buzz' });
  await wait(50);
  check('nobody else can buzz while Ben answers', tv.state.game.toss.buzzed === id(ben));
  ben.send({ t: 'guess', text: 'definitely not this' });
  check('a wrong toss-up answer puts Ben out', await tv.until(s => s.phase === 'toss' && s.game.toss.out.includes(id(ben))));
  ben.send({ t: 'buzz' });
  await wait(60);
  check('Ben cannot buzz again', tv.state.phase === 'toss');
  ann.send({ t: 'buzz' });
  await ann.until(s => s.phase === 'tossAnswer');
  ann.send({ t: 'guess', text: answer().toLowerCase() });
  check('Ann solves the toss-up', await tv.until(s => s.phase === 'tossWon' && s.game.toss.winner === id(ann) && s.game.total[id(ann)] === 1000));
  check('the answer shows once it is solved', tv.state.game.answer === answer());
  check('round 1 starts with Ann', await tv.until(s => s.phase === 'turn' && s.game.kind === 'round' && s.game.control === id(ann), 3000));
  check('round 1 uses the $2,500 wheel', tv.state.game.wheel.wedges[0] === 2500);

  // ---- round 1, played out by a simple strategy
  const by = pid => ps.find(p => id(p) === pid);
  let saw = { hit: false, miss: false, vowel: false, wrongSolve: false, time: false, bk: false, lt: false, solved: false };
  let guard = 0;
  async function turnLoop(round, wantSolveAfter) {
    let turns = 0;
    while (guard++ < 400) {
      const s = host.state, g = s.game;
      if (s.phase === 'solved' || g.kind !== 'round' || g.round !== round) return;
      if (s.phase !== 'turn' && s.phase !== 'call') { await wait(15); continue; }
      const p = by(g.control), ans = answer();
      const hidden = Board.letters(ans).split('').filter(L => !g.called.includes(L));
      if (s.phase === 'turn') {
        turns++;
        const bank = g.bank[g.control];
        if (!saw.wrongSolve && turns === 3) { p.send({ t: 'solve' }); await p.until(x => x.phase === 'solve'); p.send({ t: 'guess', text: 'WRONG GUESS HERE' }); await host.until(x => x.phase === 'pause' && x.game.last.type === 'wrongSolve'); saw.wrongSolve = true; continue; }
        if (turns >= wantSolveAfter || !g.consLeft) {
          p.send({ t: 'solve' }); await p.until(x => x.phase === 'solve');
          const before = g.total[g.control], b = g.bank[g.control];
          p.send({ t: 'guess', text: ans });
          await host.until(x => x.phase === 'solved');
          check('solve pays the bank (at least $1,000) into the total', host.state.game.total[g.control] === before + Math.max(1000, b));
          check('everyone\'s round bank resets', Object.values(host.state.game.bank).every(v => v === 0));
          saw.solved = true;
          return;
        }
        const vowel = hidden.find(L => 'AEIOU'.includes(L));
        if (!saw.vowel && bank >= 250 && vowel && g.vowelsLeft) {
          p.send({ t: 'vowel', letter: vowel });
          await host.until(x => x.phase === 'lighting');
          check('a vowel costs $250', host.state.game.bank[g.control] === bank - 250);
          saw.vowel = true;
          await host.until(x => x.phase === 'turn');
          continue;
        }
        const before = JSON.stringify(g.wheel);
        p.send({ t: 'spin', power: 0.6 });
        await host.until(x => x.phase === 'spinning' || JSON.stringify(x.game.wheel) !== before);
        await host.until(x => x.phase !== 'spinning', 4000);
        const x = host.state;
        const w = WHEELS[x.game.wheel.kind][x.game.wheel.idx];
        check('the wheel lands where the server says', wedgeAt(x.game.wheel.angle) === x.game.wheel.idx);
        if (w === 'BK') { saw.bk = true; check('Bankrupt empties the round bank', x.game.bank[p.state.me.id] === 0); }
        if (w === 'LT') saw.lt = true;
        if (w === 'BK' || w === 'LT') await host.until(y => y.phase === 'turn' && y.game.control !== p.state.me.id || y.phase === 'turn' && ps.length === 1, 3000);
        continue;
      }
      // call a consonant
      const cons = hidden.filter(L => !'AEIOU'.includes(L));
      if (!saw.time && saw.hit) { await host.until(x => x.phase === 'pause' && x.game.last.type === 'time', 3000); saw.time = true; check('too slow to call a letter loses the turn', host.state.game.last.type === 'time'); continue; }
      if (!saw.miss && saw.hit) {
        const none = 'BCDFGHJKLMNPQRSTVWXYZ'.split('').find(L => !ans.includes(L) && !g.called.includes(L));
        p.send({ t: 'call', letter: none });
        await host.until(y => y.phase === 'pause');
        check('a letter that is not there loses the turn', host.state.game.last.type === 'miss');
        saw.miss = true;
        continue;
      }
      const L = cons[0];
      const count = ans.split('').filter(c => c === L).length, value = s.game.landed, bank = g.bank[g.control];
      p.send({ t: 'call', letter: L });
      await host.until(y => y.phase === 'lighting');
      check('calling ' + L + ' pays ' + count + ' x $' + value, host.state.game.bank[g.control] === bank + count * value);
      saw.hit = true;
      await host.until(y => y.phase === 'turn', 3000);
    }
  }
  await turnLoop(1, 7);
  check('round 1 solved', saw.solved);
  check('saw a hit, a miss, a vowel, a wrong solve and a timeout', saw.hit && saw.miss && saw.vowel && saw.wrongSolve && saw.time, JSON.stringify(saw));

  // ---- host undo, mid-round
  check('round 2 toss-up is worth $2,000', await tv.until(s => s.phase === 'toss' && s.game.round === 2 && s.game.toss.value === 2000, 4000));
  // nobody buzzes: it dies once every letter is up
  check('nobody gets the toss-up', await tv.until(s => s.phase === 'tossWon' && !s.game.toss.winner, 20000));
  const starter = host.state.game.control;
  check('round 2 starts with the next player in turn', await tv.until(s => s.phase === 'turn' && s.game.round === 2, 3000), String(starter));
  check('round 2 (the last of two) uses the $3,500 wheel', tv.state.game.wheel.wedges[0] === 3500);

  const ctl = by(host.state.game.control);
  host.send({ t: 'h', a: 'adjust', id: id(ctl), field: 'bank', delta: 500 });
  check('host can fix a round bank', await host.until(s => s.game.bank[id(ctl)] === 500));
  host.send({ t: 'h', a: 'undo' });
  check('undo takes it back', await host.until(s => s.game.bank[id(ctl)] === 0));
  ctl.send({ t: 'solve' });
  await ctl.until(s => s.phase === 'solve');
  ctl.send({ t: 'guess', text: answer() + ' QQQ' });
  await host.until(s => s.phase === 'pause');
  host.send({ t: 'h', a: 'solveFor', id: id(ctl) });
  check('host can count a solve the game did not accept', await host.until(s => s.phase === 'solved' && s.game.solvedBy === id(ctl)));

  // ---- a restart in the middle of the bonus spin
  const lead = await tv.until(s => s.phase === 'bonusSpin' || (s.phase === 'toss' && s.game.toss.only), 9000);
  if (tv.state.phase === 'toss') {
    // a tie: tiebreaker toss-up among the leaders
    const only = tv.state.game.toss.only;
    check('a tie goes to a tiebreaker toss-up', only.length > 1);
    const p = by(only[0]);
    p.send({ t: 'buzz' }); await p.until(s => s.phase === 'tossAnswer');
    p.send({ t: 'guess', text: answer() });
  }
  check('the leader goes to the bonus round', lead && await tv.until(s => s.phase === 'bonusSpin', 6000));
  const bp = by(tv.state.game.bonus.pid);
  check('the bonus envelopes are sealed', tv.state.game.wheel.wedges.every(w => w === '?'));

  await wait(300);
  const blob = tv.last.backup && tv.last.backup.blob;
  check('the TV holds a sealed copy of the game', !!blob);
  const room = rooms.get(code);
  clearTimeout(room.timer); clearTimeout(room.backupTimer);
  rooms.delete(code);
  tv.send({ t: 'watch', code, token });
  check('server forgot the room', await tv.until((s, l) => l.error && l.error.code === 'noroom'));
  tv.send({ t: 'restore', code, token, blob, idle: 0 });
  check('the TV hands the game back', await tv.until((s, l) => l.watching && l.watching.restored && s.phase === 'bonusSpin'));
  for (const p of [host, ...ps]) { p.send({ t: 'rejoin', code, token: host === p ? host.last.joined.token : p.last.joined.token }); }
  check('everyone is back', await tv.until(s => s.players.every(p => p.on)));

  bp.send({ t: 'spin', power: 0.9 });
  check('bonus wheel spins', await tv.until(s => s.phase === 'bonusSpinning'));
  check('R S T L N E go up', await tv.until(s => s.phase === 'bonusLighting' && 'RSTLNE'.split('').every(L => s.game.called.includes(L)), 4000));
  check('then the pick', await bp.until(s => s.phase === 'bonusPick', 4000));
  bp.send({ t: 'picks', letters: ['R', 'C', 'D', 'A'] });
  await wait(60);
  check('R was already given, so that pick is refused', bp.state.phase === 'bonusPick');
  bp.send({ t: 'picks', letters: ['C', 'D', 'M', 'A'] });
  check('picks go up, then the clock', await tv.until(s => s.phase === 'bonusSolve', 5000));
  bp.send({ t: 'guess', text: 'nope' });
  check('a wrong bonus guess keeps the clock going', await tv.until(s => s.game.bonus.guesses.includes('NOPE') && s.phase === 'bonusSolve'));
  const before = tv.state.game.total[id(bp)];
  bp.send({ t: 'guess', text: answer() });
  check('bonus solved: the envelope is opened and paid', await tv.until(s => s.phase === 'bonusDone' && s.game.bonus.solved && s.game.total[id(bp)] === before + s.game.bonus.prize && s.game.bonus.prize >= 30000));
  check('game over with awards', await tv.until(s => s.phase === 'gameOver' && s.game.awards.length > 0, 4000));
  check('each phone gets its own numbers', await ann.until(s => s.me.stats && typeof s.me.stats.hits === 'number'));

  // ---- back to the lobby; with no host, the captain runs it
  host.send({ t: 'h', a: 'lobby' });
  check('back to the lobby', await tv.until(s => s.phase === 'lobby'));
  host.send({ t: 'host', on: false });
  check('host steps down: Ann is captain', await ann.until(s => s.me.isCaptain));
  ann.send({ t: 'h', a: 'settings', rounds: 2 });
  ann.send({ t: 'h', a: 'start' });
  check('the captain starts a game', await tv.until(s => s.phase === 'toss'));
  ann.send({ t: 'h', a: 'undo' });
  await wait(50);
  check('only a host can undo', tv.state.phase === 'toss');

  for (const s of [tv, host, ...ps]) s.close();
  server.close();
  console.log(failures ? '\n' + failures + ' FAILED' : '\nall good');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
