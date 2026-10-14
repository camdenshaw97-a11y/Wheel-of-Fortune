/* Puzzle editor: used on the TV page and on the host's (or captain's) phone.
   The host's own puzzles are a category and a puzzle each. They are saved on the device and
   sent to the server, where they are used before the built-in packs. */
(function () {
  'use strict';
  var F = window.Game, B = window.Board;
  var KEY = 'whl.custom';
  var CATS = ['PHRASE', 'THING', 'PLACE', 'PERSON', 'EVENT', 'FOOD & DRINK', 'WHAT ARE YOU DOING?', 'BEFORE & AFTER', 'FUN & GAMES', 'SHOW BIZ', 'RHYME TIME', 'INSIDE JOKE'];

  function normalize(c) {
    c = c && typeof c === 'object' ? c : {};
    return { puzzles: Array.isArray(c.puzzles) ? c.puzzles.filter(function (p) { return p && p.cat && p.text; }) : [] };
  }
  F.savedCustom = function () { return normalize(F.store.get(KEY, null)); };

  function preview(text) {
    var lay = B.layout(text);
    if (lay.err) return '<div class="ed-err">' + F.esc(text.trim() ? lay.err : '') + '</div>';
    var board = new Array(56).fill('');
    lay.cells.forEach(function (c) { board[c.i] = c.ch; });
    return F.miniBoard(board);
  }

  F.openEditor = function (opts) {
    // opts: { custom: { puzzles }, onChange(custom), onClose() }
    var data = normalize(JSON.parse(JSON.stringify(opts.custom || {})));
    var back = document.createElement('div');
    back.className = 'ed-back';
    document.body.appendChild(back);

    function commit() { F.store.set(KEY, data); opts.onChange(data); }
    function close() {
      if (F.motionOK()) { back.classList.add('out'); setTimeout(function () { back.remove(); }, 200); }
      else back.remove();
      if (opts.onClose) opts.onClose();
    }

    function showList() {
      var h = '<div class="ed"><div class="ed-top"><h2>MY PUZZLES</h2><button class="ed-btn" data-a="close">Done</button></div>' +
        '<p>Your own puzzles are played first; the built-in packs fill in the rest. A game uses a toss-up and a puzzle per round, ' +
        'plus a short one for the bonus round. Everything here is saved on this device and reloads next time.</p>' +
        '<div class="ed-row"><button class="ed-btn pri" data-a="add">+ Add a puzzle</button>' +
        '<button class="ed-btn ghost" data-a="export"' + (data.puzzles.length ? '' : ' disabled') + '>Save to file</button>' +
        '<button class="ed-btn ghost" data-a="import">Load from file</button></div>' +
        '<h3>PUZZLES (' + data.puzzles.length + ')</h3>';
      if (!data.puzzles.length) h += '<div class="ed-empty">No puzzles yet. Inside jokes and friends’ catchphrases make the best ones.</div>';
      data.puzzles.forEach(function (p, i) {
        h += '<div class="ed-q"><b>' + F.esc(p.text) + '<small>' + F.esc(p.cat) + '</small></b>' +
          '<button class="ed-btn" data-a="edit" data-i="' + i + '">Edit</button>' +
          '<button class="ed-btn red" data-a="del" data-i="' + i + '">Delete</button></div>';
      });
      h += '<input type="file" accept=".json,application/json" style="display:none" data-file></div>';
      back.innerHTML = h;
    }

    function showOne(i) {
      var p = i == null ? { cat: 'PHRASE', text: '' } : data.puzzles[i];
      var h = '<div class="ed"><div class="ed-top"><h2>' + (i == null ? 'NEW PUZZLE' : 'EDIT PUZZLE') + '</h2></div>' +
        '<label>CATEGORY</label><input data-cat maxlength="30" list="ed-cats" placeholder="PHRASE" value="' + F.esc(p.cat) + '">' +
        '<datalist id="ed-cats">' + CATS.map(function (c) { return '<option value="' + F.esc(c) + '">'; }).join('') + '</datalist>' +
        '<label>PUZZLE</label><input data-text maxlength="60" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ONCE IN A BLUE MOON" value="' + F.esc(p.text) + '">' +
        '<p>Letters, spaces and \' &amp; ? ! . , : - only. Spell out numbers. It must fit the board: four rows of 12, 14, 14 and 12 tiles.</p>' +
        '<div data-prev>' + preview(p.text) + '</div>' +
        '<div class="ed-err" data-err></div><div class="ed-row"><button class="ed-btn pri" data-a="save" data-i="' + (i == null ? '' : i) + '">Save puzzle</button>' +
        '<button class="ed-btn ghost" data-a="cancel">Cancel</button></div></div>';
      back.innerHTML = h;
      back.scrollTop = 0;
    }

    back.addEventListener('input', function (e) {
      if (e.target.matches('[data-text]')) back.querySelector('[data-prev]').innerHTML = preview(e.target.value);
    });
    back.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var a = b.dataset.a, i = b.dataset.i === '' || b.dataset.i == null ? null : Number(b.dataset.i);
      if (a === 'close') close();
      else if (a === 'add') showOne(null);
      else if (a === 'edit') showOne(i);
      else if (a === 'del') { if (confirm('Delete "' + data.puzzles[i].text + '"?')) { data.puzzles.splice(i, 1); commit(); showList(); } }
      else if (a === 'cancel') showList();
      else if (a === 'save') {
        var cat = back.querySelector('[data-cat]').value.trim().toUpperCase(), text = B.tidy(back.querySelector('[data-text]').value);
        var lay = B.layout(text);
        if (!cat) { back.querySelector('[data-err]').textContent = 'Give it a category.'; return; }
        if (lay.err) { back.querySelector('[data-err]').textContent = lay.err; return; }
        if (i == null) data.puzzles.push({ cat: cat, text: lay.text }); else data.puzzles[i] = { cat: cat, text: lay.text };
        commit(); showList();
      } else if (a === 'export') {
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var aEl = document.createElement('a');
        aEl.href = URL.createObjectURL(blob); aEl.download = 'my-puzzles.json';
        document.body.appendChild(aEl); aEl.click(); aEl.remove();
      } else if (a === 'import') back.querySelector('[data-file]').click();
    });
    back.addEventListener('change', function (e) {
      var inp = e.target; if (!inp.matches('[data-file]') || !inp.files[0]) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var got = normalize(JSON.parse(rd.result)), n = 0;
          got.puzzles.forEach(function (p) {
            var lay = B.layout(p.text);
            if (!lay.err) { data.puzzles.push({ cat: String(p.cat).toUpperCase().slice(0, 30), text: lay.text }); n++; }
          });
          commit(); showList();
          if (!n) alert('No puzzles found in that file.');
        } catch (err) { alert('That file could not be read.'); }
      };
      rd.readAsText(inp.files[0]);
    });

    showList();
    return { close: close };
  };
})();
