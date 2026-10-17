# Friend Wheel: what changed, and when

Every change to the game gets an entry here, newest first. The version number is the same one
shown in small print on the TV's start screen and on the phone join screen, so you can tell at a
glance which version a screen is running.

Times are Pacific.

## 1.1 · October 17, 2026

**Fixes from the first play test**
- **Bigger alphabet on the phones.** The used-letter alphabet under the board is now two rows of
  big letter tiles (A to M, N to Z) instead of one line of small print. Vowels have a gold tint,
  and letters already called are crossed out and faded.
- **Join after the game has started.** Anyone who opens the game mid-game now gets two buttons:
  **Jump in and play** (they start at $0 and take a turn when it comes round) and **Be the
  host** (if nobody is hosting). The TV shows "NAME JUMPS IN!" when someone joins.
- **The host can switch to playing mid-game**: Host menu (**More…**) > **Join as a player**.
  The game keeps running on its own without a host.

## 1.0 · October 14, 2026

**The first version**
- Third game in the collection, built the same way as Friend Feud and Friend Jeopardy: the board
  on the TV, a 4-letter room code or QR code to join, the same reconnecting and "survives a
  server restart" behavior.
- 2 to 8 players, each on their own phone. Swipe the wheel on your phone to spin (a harder flick
  spins it harder), tap a letter to call it, type to solve. The game checks everything itself,
  so a host is optional: with no host, the first player is the captain and starts the game.
- Follows the show: a toss-up before every round ($1,000 / $2,000 / $3,000, straight into your
  total), $250 vowels, Bankrupt and Lose a Turn, calling a letter that isn't there passes the
  turn, solving banks at least $1,000, three wheels ($2,500, $3,500 and $5,000 tops), and the
  bonus round: a sealed envelope from the gold wheel, R S T L N E free, three consonants and a
  vowel, 10 seconds to solve. A tie for the lead gets a tiebreaker toss-up.
- Typed solves forgive spaces, punctuation and a typo in a long puzzle.
- 252 original puzzles in nine packs (including an 18+ Late Night pack), no repeats across
  games, and an editor for your own puzzles with a live board preview.
- Optional host tools: see the answer, undo, skip a turn, count a solve the game didn't accept,
  nobody-gets-it, fix scores, give the turn to someone, remove a player, end early.
- Setup: 2, 3 or 4 rounds, a letter clock (10, 15, 20 seconds or off), bonus round on or off.
- Awards on the closing screen: Most Solves, Best Letter Caller, Biggest Single Call, Bankrupt
  Magnet. Each phone shows that player's own numbers.
- `npm test` plays a full game against the server and checks the rules.
