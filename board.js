/*
 * The puzzle board, shared by the server and the pages (the editor checks that a puzzle fits).
 * The board is 4 rows of 14 tiles; the top and bottom rows are 12 wide, like the show's.
 * A puzzle is laid out on as few rows as it fits, words never split, each row centred.
 */
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.Board = make();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var COLS = 14, ROWS = 4, CAPS = [12, 14, 14, 12];
  var VOWELS = 'AEIOU';
  // Which rows a puzzle of 1, 2, 3 or 4 lines uses.
  var ROWSETS = { 1: [[1]], 2: [[1, 2]], 3: [[0, 1, 2], [1, 2, 3]], 4: [[0, 1, 2, 3]] };

  function tidy(text) {
    return String(text == null ? '' : text).toUpperCase()
      .replace(/[‘’`´]/g, "'").replace(/[“”"]/g, '')
      .replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  }

  // Every way to cut n words into k lines, as lists of line lengths in words.
  function cuts(n, k) {
    if (k === 1) return [[n]];
    var out = [];
    for (var first = 1; first <= n - k + 1; first++) {
      cuts(n - first, k - 1).forEach(function (rest) { out.push([first].concat(rest)); });
    }
    return out;
  }

  /* Returns { text, cells: [{ i, ch }] } or { err } when the puzzle can't go on the board.
     i is the tile index, row * 14 + column. */
  function layout(text) {
    var t = tidy(text);
    if (!t) return { err: 'Type a puzzle.' };
    if (!/^[A-Z '&?!.,:\-]+$/.test(t)) return { err: 'Letters only (plus spaces and \' & ? ! . , : -). Spell out numbers.' };
    if (!/[A-Z]/.test(t)) return { err: 'The puzzle needs some letters.' };
    var words = t.split(' ');
    for (var w = 0; w < words.length; w++) if (words[w].length > COLS) return { err: '"' + words[w] + '" is too long for one row (14 tiles).' };
    for (var k = 1; k <= ROWS; k++) {
      if (k > words.length) break;
      var best = null;
      cuts(words.length, k).forEach(function (cut) {
        var lines = [], at = 0;
        cut.forEach(function (n) { lines.push(words.slice(at, at + n).join(' ')); at += n; });
        ROWSETS[k].forEach(function (rows) {
          for (var j = 0; j < k; j++) if (lines[j].length > CAPS[rows[j]]) return;
          var mean = lines.reduce(function (a, l) { return a + l.length; }, 0) / k;
          var score = lines.reduce(function (a, l) { return a + (l.length - mean) * (l.length - mean); }, 0);
          if (!best || score < best.score) best = { lines: lines, rows: rows, score: score };
        });
      });
      if (best) {
        var cells = [];
        best.lines.forEach(function (line, j) {
          var r = best.rows[j], cap = CAPS[r], off = r === 0 || r === 3 ? 1 : 0;
          var start = off + Math.floor((cap - line.length) / 2);
          for (var c = 0; c < line.length; c++) if (line[c] !== ' ') cells.push({ i: r * COLS + start + c, ch: line[c] });
        });
        return { text: t, cells: cells };
      }
    }
    return { err: 'Too long: the board holds 4 rows (12, 14, 14 and 12 tiles).' };
  }

  var isLetter = function (ch) { return ch >= 'A' && ch <= 'Z'; };
  var isVowel = function (ch) { return VOWELS.indexOf(ch) >= 0; };
  var letters = function (s) { return tidy(s).replace(/[^A-Z]/g, ''); };

  function distance(a, b) {
    if (a === b) return 0;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /* Is a typed solve right? Spaces and punctuation don't matter. Long puzzles forgive a typo
     (one in a 12-letter puzzle, two from 24), since everyone is typing on a phone. */
  function matches(guess, answer) {
    var g = letters(guess), a = letters(answer);
    if (!g) return false;
    if (g === a) return true;
    var slack = a.length >= 24 ? 2 : a.length >= 12 ? 1 : 0;
    return slack > 0 && Math.abs(g.length - a.length) <= slack && distance(g, a) <= slack;
  }

  return { COLS: COLS, ROWS: ROWS, CAPS: CAPS, VOWELS: VOWELS, tidy: tidy, layout: layout, isLetter: isLetter, isVowel: isVowel, letters: letters, matches: matches };
});
