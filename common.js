/* Shared by the TV page and the phone page. */
(function () {
  'use strict';
  var F = window.Game = {};

  // Change this to rename the game everywhere.
  F.TITLE = 'FRIEND WHEEL';
  // Shown small on the start screens. Goes up with every change; CHANGELOG.md says what each one was.
  F.VERSION = '1.1';

  F.$ = function (sel, root) { return (root || document).querySelector(sel); };
  F.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  F.money = function (n) { n = Number(n) || 0; return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US'); };
  F.plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };

  F.store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };

  /* ---- live connection with automatic reconnect ---- */
  F.connect = function (opts) {
    var ws = null, timer = null, tries = 0, stopped = false;
    var myBuild = document.documentElement.getAttribute('data-build');
    function freshCheck() {
      if (!myBuild || !window.fetch) return;
      fetch('/version', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (v) {
        if (!/^[0-9a-f]{12}$/.test(v) || v === myBuild) return;
        var last = Number(F.store.get('whl.reloadAt', 0));
        if (Date.now() - last < 30000) return;
        F.store.set('whl.reloadAt', Date.now());
        try { sessionStorage.setItem('whl.auto', '1'); } catch (e) { /* private mode */ }
        location.reload();
      }).catch(function () { /* offline: try again next time */ });
    }
    function open() {
      timer = null;
      if (stopped) return;
      try {
        ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      } catch (e) { return retry(); }
      var mine = ws;
      mine.onopen = function () {
        tries = 0;
        freshCheck();
        if (opts.onStatus) opts.onStatus(true);
        var h = opts.hello && opts.hello();
        if (h) mine.send(JSON.stringify(h));
      };
      mine.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (err) { return; }
        opts.onMessage(m);
      };
      mine.onclose = function () {
        if (ws !== mine) return;
        if (opts.onStatus) opts.onStatus(false);
        retry();
      };
      mine.onerror = function () { try { mine.close(); } catch (e) { /* ignore */ } };
    }
    function retry() {
      if (stopped || timer) return;
      timer = setTimeout(open, Math.min(4000, 300 + 500 * tries++));
    }
    var api = {
      send: function (m) {
        if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; }
        return false;
      },
      stop: function () { stopped = true; if (timer) clearTimeout(timer); try { ws.close(); } catch (e) { /* ignore */ } }
    };
    open();
    setInterval(function () { api.send({ t: 'ping' }); }, 20000);
    setInterval(function () { try { fetch('/health').catch(function () {}); freshCheck(); } catch (e) { /* ignore */ } }, 4 * 60 * 1000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !stopped && (!ws || ws.readyState > 1)) {
        if (timer) { clearTimeout(timer); timer = null; }
        tries = 0; open();
      }
    });
    return api;
  };

  /* ---- keep the screen awake while the game is open ---- */
  F.stayAwake = function () {
    var lock = null;
    function ask() {
      if (!navigator.wakeLock || document.hidden) return;
      try { navigator.wakeLock.request('screen').then(function (l) { lock = l; }).catch(function () {}); } catch (e) { /* not allowed here */ }
    }
    ask();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) ask(); });
    document.addEventListener('click', function () { if (!lock) ask(); }, { passive: true });
  };

  /* ---- shrink text until it fits ---- */
  F.fit = function (el, min) {
    el.style.fontSize = '';
    var size = parseFloat(getComputedStyle(el).fontSize);
    var floor = min || size * 0.45;
    var guard = 0;
    while (el.scrollWidth > el.clientWidth + 1 && size > floor && guard++ < 60) {
      size -= Math.max(1, size * 0.05);
      el.style.fontSize = size + 'px';
    }
  };

  /* ---- motion helpers ---- */
  var calm = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  F.motionOK = function () { return !(calm && calm.matches); };
  F.anim = function (el, frames, opts) {
    if (!el || !el.animate || !F.motionOK()) return null;
    try { return el.animate(frames, opts); } catch (e) { return null; }
  };
  F.bump = function (el, scale) {
    return F.anim(el, [{ transform: 'scale(1)' }, { transform: 'scale(' + (scale || 1.2) + ')', offset: 0.4 }, { transform: 'scale(1)' }],
      { duration: 380, easing: 'cubic-bezier(.3, 1.3, .5, 1)' });
  };
  F.shake = function (el) {
    return F.anim(el, [0, -6, 12, -18, 18, -14, 12, -8, 4, 0].map(function (x) { return { transform: 'translateX(' + x + 'px)' }; }), { duration: 480, easing: 'ease-out' });
  };

  /* ---- redraw a block of HTML without throwing away what is already on screen ----
     data-key="..." (or an id) marks an element as "the same one" between redraws.
     data-live means "leave my contents alone": a script is animating them. */
  function keyOf(n) { return n.nodeType === 1 ? (n.getAttribute('data-key') || n.id || null) : null; }
  function morphKids(from, to) {
    var want = {}, cur = from.firstChild, next = to.firstChild, n, k, hit, c, clear;
    function id(x) { var kk = keyOf(x); return kk ? x.nodeName + '|' + kk : null; }
    function drop(x) { if (x === cur) cur = cur.nextSibling; from.removeChild(x); }
    for (n = to.firstChild; n; n = n.nextSibling) if (id(n)) want[id(n)] = 1;
    while (next) {
      n = next; next = next.nextSibling;
      while (cur && id(cur) && !want[id(cur)]) drop(cur);
      k = id(n); hit = null;
      for (c = cur; c; c = c.nextSibling) if (k ? id(c) === k : (!id(c) && c.nodeName === n.nodeName)) { hit = c; break; }
      if (hit && hit !== cur) {
        clear = true;
        for (c = cur; c !== hit; c = c.nextSibling) if (id(c) && want[id(c)]) { clear = false; break; }
        if (clear) while (cur !== hit) drop(cur);
      }
      if (hit) {
        if (hit === cur) cur = cur.nextSibling; else from.insertBefore(hit, cur);
        morphNode(hit, n);
      } else from.insertBefore(n, cur);
    }
    while (cur) drop(cur);
  }
  function morphNode(a, b) {
    if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    var i, at, name;
    for (i = a.attributes.length - 1; i >= 0; i--) {
      name = a.attributes[i].name;
      if (!b.hasAttribute(name) && name.indexOf('data-fx-') !== 0) a.removeAttribute(name);
    }
    for (i = 0; i < b.attributes.length; i++) {
      at = b.attributes[i];
      if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    }
    if (a.nodeName === 'INPUT' || a.nodeName === 'TEXTAREA') {
      if (document.activeElement !== a) { var v = b.getAttribute('value') || ''; if (a.value !== v) a.value = v; }
      return;
    }
    if (a.hasAttribute('data-live')) return;
    morphKids(a, b);
  }
  F.morph = function (root, html) {
    var t = document.createElement('template');
    t.innerHTML = html;
    morphKids(root, t.content);
  };

  /* ---- count a number up or down ---- */
  F.countTo = function (el, to, ms, fmt) {
    fmt = fmt || F.money;
    var from = el._n == null ? to : el._n;
    el._n = to;
    if (el._raf) cancelAnimationFrame(el._raf);
    if (from === to || !ms || !F.motionOK()) { el.textContent = fmt(to); return; }
    var t0 = performance.now();
    (function step(now) {
      var k = Math.min(1, (now - t0) / ms);
      el.textContent = fmt(Math.round(from + (to - from) * k));
      if (k < 1) el._raf = requestAnimationFrame(step);
    })(t0);
  };

  /* Buttons stay pressed for a beat even on a quick tap, so every tap is felt. */
  F.pressFx = function () {
    var held = null, t0 = 0;
    function release() {
      var b = held; held = null;
      if (b) setTimeout(function () { b.removeAttribute('data-fx-press'); }, Math.max(0, 110 - (performance.now() - t0)));
    }
    document.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('button, a.tvbtn, a.link') : null;
      if (!b || b.disabled) return;
      if (held && held !== b) held.removeAttribute('data-fx-press');
      held = b; t0 = performance.now();
      b.setAttribute('data-fx-press', '');
    }, { passive: true });
    ['pointerup', 'pointercancel', 'blur'].forEach(function (ev) { addEventListener(ev, release, { passive: true }); });
    document.addEventListener('touchstart', function () {}, { passive: true });
  };

  /* ---- sound effects, synthesized so there are no audio files to load ---- */
  F.sfx = (function () {
    var ctx = null, muted = false, master = null;
    function ac() {
      if (!ctx) {
        var C = window.AudioContext || window.webkitAudioContext;
        if (C) { ctx = new C(); master = ctx.createGain(); master.gain.value = muted ? 0 : 1; master.connect(ctx.destination); }
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(o) {
      var c = ac(); if (!c || muted) return;
      var t = c.currentTime + (o.t || 0), d = o.d || 0.3;
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, t);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + d);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(o.g || 0.3, t + 0.012);
      if (o.hold) g.gain.setValueAtTime(o.g || 0.3, t + d - 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + d + 0.05);
    }
    function noise(t, d, g, freq) {
      var c = ac(); if (!c || muted) return;
      var n = Math.floor(c.sampleRate * d), buf = c.createBuffer(1, n, c.sampleRate), data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = c.createBufferSource(), f = c.createBiquadFilter(), gn = c.createGain();
      src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq || 2500; f.Q.value = 1.2;
      gn.gain.value = g;
      src.connect(f); f.connect(gn); gn.connect(master);
      src.start(c.currentTime + (t || 0));
    }
    function bell(f, t, g) {
      tone({ f: f, t: t, d: 1.0, g: g }); tone({ f: f * 2, t: t, d: 0.6, g: g * 0.35 }); tone({ f: f * 3.01, t: t, d: 0.3, g: g * 0.15 });
    }
    function buzzer(t, d) {
      tone({ f: 138, type: 'sawtooth', t: t, d: d, g: 0.32, hold: true });
      tone({ f: 146, type: 'square', t: t, d: d, g: 0.18, hold: true });
      tone({ f: 92, type: 'sawtooth', t: t, d: d, g: 0.28, hold: true });
    }
    return {
      unlock: ac,
      ctx: ac,
      mute: function (v) { muted = v; if (master) master.gain.setTargetAtTime(v ? 0 : 1, ctx.currentTime, 0.03); },
      isMuted: function () { return muted; },
      peg: function () { noise(0, 0.035, 0.5, 3200); tone({ f: 1900, type: 'square', d: 0.02, g: 0.04 }); },   // the wheel's flapper on a peg
      ding: function () { bell(1568, 0, 0.26); },                                                      // a letter lights up
      reveal: function () { tone({ f: 880, type: 'triangle', d: 0.12, g: 0.12 }); tone({ f: 1320, type: 'triangle', t: 0.05, d: 0.18, g: 0.08 }); },
      buzz: function () { bell(1318.5, 0, 0.3); },                                                    // a buzz-in
      wrong: function () { buzzer(0, 0.5); },
      bankrupt: function () {
        [392, 370, 349, 311].forEach(function (f, i) { tone({ f: f, type: 'sawtooth', t: i * 0.22, d: i === 3 ? 0.8 : 0.24, g: 0.16 }); });
        tone({ f: 120, f2: 50, type: 'triangle', t: 0.66, d: 0.9, g: 0.3 });
      },
      loseTurn: function () { tone({ f: 523, type: 'triangle', d: 0.2, g: 0.18 }); tone({ f: 392, type: 'triangle', t: 0.2, d: 0.45, g: 0.18 }); },
      solve: function () {
        [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.1, d: i === 6 ? 1.1 : 0.16, g: 0.24 }); });
        [262, 330, 392].forEach(function (f) { tone({ f: f, type: 'sawtooth', t: 0.6, d: 1.0, g: 0.06 }); });
      },
      tick: function () { tone({ f: 1000, type: 'square', d: 0.04, g: 0.09 }); },
      join: function () { tone({ f: 660, d: 0.09, g: 0.14 }); tone({ f: 990, t: 0.08, d: 0.2, g: 0.14 }); },
      round: function () {
        [392, 523, 659].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.1, d: 0.16, g: 0.2 }); });
        bell(1047, 0.32, 0.24);
      },
      toss: function () { [659, 784, 988].forEach(function (f, i) { tone({ f: f, type: 'square', t: i * 0.08, d: 0.12, g: 0.07 }); }); },
      win: function () {
        [523, 523, 523, 659, 784, 659, 784, 1047].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.15, d: i === 7 ? 1.2 : 0.22, g: 0.26 }); });
        [262, 330, 392].forEach(function (f) { tone({ f: f, type: 'sawtooth', t: 1.05, d: 1.2, g: 0.07 }); });
      },
      lose: function () { [392, 370, 349, 330].forEach(function (f, i) { tone({ f: f, type: 'triangle', t: i * 0.25, d: i === 3 ? 0.9 : 0.3, g: 0.22 }); }); },
      whoosh: function () { tone({ f: 220, f2: 880, type: 'sine', d: 0.45, g: 0.08 }); }
    };
  })();

  /* ---- the wheel ----
     24 wedges, wedge i runs from i*15 to (i+1)*15 degrees, measured clockwise from the top.
     Turning the wheel clockwise by A degrees puts wedge "Wheel.at(A)" under the pointer at the top. */
  var WEDGE = 15;
  var PALETTE = ['#e8352b', '#f28a1d', '#f7c928', '#3bb54a', '#1f8be0', '#8a3fd1', '#ef4f9a', '#19b6b0'];
  function pt(r, deg) { var a = deg * Math.PI / 180; return (r * Math.sin(a)).toFixed(2) + ',' + (-r * Math.cos(a)).toFixed(2); }
  function short(n) { return n >= 1000 && n % 1000 === 0 && n >= 10000 ? '$' + (n / 1000) + 'K' : '$' + n; }
  var svgSeq = 0;
  F.wheelSvg = function (wedges, kind) {
    var R = 480, u = 'wh' + (++svgSeq), h = '<svg viewBox="-500 -500 1000 1000" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">';
    h += '<defs><radialGradient id="' + u + 'Hub" cx="40%" cy="35%"><stop offset="0" stop-color="#fff6c8"/><stop offset=".55" stop-color="#e2b33a"/><stop offset="1" stop-color="#8a5a06"/></radialGradient>' +
      '<radialGradient id="' + u + 'Shade" cx="50%" cy="50%" r="50%"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></radialGradient></defs>';
    h += '<circle r="498" fill="#1b1b1f"/><circle r="490" fill="#d7a531"/>';
    wedges.forEach(function (w, i) {
      var a0 = i * WEDGE, a1 = a0 + WEDGE, mid = a0 + WEDGE / 2;
      var fill, ink = '#fff', label;
      if (kind === 'bonus') { fill = i % 2 ? '#d9b44a' : '#f0d77a'; ink = '#3b2600'; label = w === '?' ? '?' : short(w); }
      else if (w === 'BANKRUPT') { fill = '#0c0c0c'; label = 'BANKRUPT'; }
      else if (w === 'LOSE A TURN') { fill = '#f4f4f4'; ink = '#111'; label = 'LOSE A TURN'; }
      else { fill = PALETTE[i % PALETTE.length]; label = '$' + w; if (i === 0) { fill = '#c0c7d4'; ink = '#141a28'; } if (fill === '#f7c928') ink = '#3a2a00'; }
      h += '<path d="M0,0 L' + pt(R, a0) + ' A' + R + ',' + R + ' 0 0 1 ' + pt(R, a1) + ' Z" fill="' + fill + '" stroke="#1b1b1f" stroke-width="3"/>';
      // The label reads down the wedge from the rim, one character under the next, like the show's.
      var chars = label.replace(/ /g, ' ').split(''), n = chars.length;
      var size = n > 9 ? 25 : n > 6 ? 32 : n > 4 ? 46 : 56, step = size * (n > 6 ? 0.92 : 0.98), r0 = 448 - size * 0.6;
      h += '<g transform="rotate(' + mid + ')" font-family="Anton, Impact, sans-serif" font-size="' + size + '" fill="' + ink + '" text-anchor="middle">';
      chars.forEach(function (ch, k) { if (ch !== ' ') h += '<text x="0" y="' + (-(r0 - k * step)).toFixed(1) + '" dominant-baseline="central">' + F.esc(ch) + '</text>'; });
      h += '</g>';
    });
    for (var i = 0; i < 24; i++) h += '<circle cx="' + pt(470, i * WEDGE).split(',')[0] + '" cy="' + pt(470, i * WEDGE).split(',')[1] + '" r="7" fill="#f6e7b0" stroke="#5a4310" stroke-width="2"/>';
    h += '<circle r="480" fill="url(#' + u + 'Shade)"/>';
    h += '<circle r="92" fill="#1b1b1f"/><circle r="84" fill="url(#' + u + 'Hub)"/><circle r="40" fill="none" stroke="#fff3" stroke-width="4"/>';
    return h + '</svg>';
  };
  F.wedgeAt = function (a) { return Math.floor((((360 - (a % 360)) % 360)) / WEDGE) % 24; };

  /* Turns a wheel element to match the game's wheel: animates a spin that's under way (starting
     part-way in if this screen joined late), or snaps to where it stopped. onPeg fires on every
     peg that passes the pointer. */
  F.spinner = function (el, onPeg) {
    var raf = null, key = null, cur = 0;
    function set(a) { cur = a; el.style.transform = 'rotate(' + a.toFixed(2) + 'deg)'; }
    function ease(t) { return 1 - Math.pow(1 - t, 3.4); }
    return {
      angle: function () { return cur; },
      set: set,
      sync: function (w) {
        var k = w.from + '>' + w.angle;
        if (k === key) return;
        key = k;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        if (w.elapsed == null || w.elapsed >= w.dur || !F.motionOK()) { set(w.angle); return; }
        var t0 = performance.now() - w.elapsed, last = Math.floor(w.from / WEDGE);
        (function step(now) {
          var k2 = Math.min(1, (now - t0) / w.dur);
          var a = w.from + (w.angle - w.from) * ease(k2);
          set(a);
          var peg = Math.floor(a / WEDGE);
          if (peg !== last) { last = peg; if (onPeg && k2 < 0.995) onPeg(); }
          if (k2 < 1) raf = requestAnimationFrame(step); else raf = null;
        })(performance.now());
      },
      spinning: function () { return !!raf; }
    };
  };

  /* A small copy of the puzzle board for phones. */
  F.miniBoard = function (board) {
    var h = '<div class="mini">';
    for (var i = 0; i < 56; i++) {
      var r = Math.floor(i / 14), c = i % 14, v = board[i];
      if ((r === 0 || r === 3) && (c === 0 || c === 13)) { h += '<i class="x"></i>'; continue; }
      h += v === '' ? '<i></i>' : v === '.' ? '<i class="b"></i>' : '<i class="l">' + F.esc(v) + '</i>';
    }
    return h + '</div>';
  };
})();
