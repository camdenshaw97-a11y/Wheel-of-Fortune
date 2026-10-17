# Friend Wheel

A spin-the-wheel word-puzzle party game, built the same way as Friend Feud and Friend Jeopardy.
The puzzle board and the wheel go on the TV, and every player's phone does the rest: swipe to
spin, tap to call a letter, type to solve. The game checks the answers itself, so a host is
optional.

## Playing

1. On the computer plugged into the TV, open `YOUR-SITE/tv` and click **Start a new game**.
   Press `F` for full screen.
2. Everyone else opens `YOUR-SITE` on their phone (or scans the QR code on the TV) and types
   the 4-letter room code and their name.
3. Players tap **I'm playing** (2 to 8 is best). If someone wants to run the show instead of
   playing, they tap **Be the host**. With no host, the first player to join is the captain and
   starts the game.
4. The host (or captain) picks the setup and taps **Start the game**.
5. Late arrivals can still join after the game starts: they get **Jump in and play** (starting
   at $0) or, if nobody is hosting, **Be the host**. A host can switch to playing any time from
   the host menu (**More…** > **Join as a player**).

## Rules it follows

- **Toss-ups.** Every round starts with one. Letters appear one at a time; buzz on your phone
  and type the whole puzzle. Right: the money ($1,000, then $2,000, then $3,000) goes straight
  into your total, and you start the round. Wrong: you're out of that toss-up and the letters
  keep coming. If nobody gets it, the next player in turn starts.
- **Your turn.** Swipe the wheel on your phone. A harder flick spins it harder. Then:
  - **A dollar amount:** call a consonant. Each one in the puzzle pays that amount into your
    round money and you go again. None there (or already called): the turn passes.
  - **Bankrupt:** your round money is gone and the turn passes. Your total is safe.
  - **Lose a Turn:** the turn passes.
  - **Buy a vowel** for $250 of round money instead of spinning.
  - **Solve:** type the puzzle. Right: your round money (at least $1,000) moves into your total
    and everyone else's round money is lost. Wrong: the turn passes.
  - When no consonants are left you can only buy a vowel or solve.
- **The wheels.** Round one tops out at $2,500, the middle rounds at $3,500 and the last round
  of a 3- or 4-round game at $5,000. Every wheel has two Bankrupts and a Lose a Turn.
- **The bonus round.** The player with the biggest total spins the gold wheel to pick a sealed
  envelope ($30,000 to $100,000). R S T L N E go up for free, they pick three more consonants
  and a vowel, then they have 10 seconds to solve, with as many tries as they can type. The
  envelope is opened at the end. A tie for the lead is settled by a tiebreaker toss-up first.
- **Typing.** Spaces, punctuation and capitals don't matter. Long puzzles forgive a typo
  (one in a 12-letter puzzle, two from 24), since everyone is typing on a phone.

## Setup (host or captain, in the lobby)

- **Rounds:** 2, 3 or 4.
- **Letter clock:** after a spin, how long you have to call a letter (10, 15 or 20 seconds, or
  off). Typing a solve always gets 45 seconds; a toss-up answer gets 15.
- **Bonus round:** on or off.
- **Puzzle packs:** Classic, Food & Drink, Before & After, What Are You Doing?, Fun & Games,
  Show Biz, Rhyme Time, On the Map, and an adults-only Late Night pack. Switch on any mix.
- **No repeats:** a puzzle doesn't come back until every other one in the packs you have on has
  been played. The TV remembers what it has shown.
- **Write puzzles** (lobby, or **My puzzles** on the TV): a category and a puzzle each, with a
  preview of how it sits on the board. They're played before the built-in packs and saved on
  that device. Save to file / Load from file moves them between devices.

## Host tools (optional)

The host doesn't play. Their phone shows the answer, and:

- **Undo** the last move, **Skip turn** (someone is stuck), **Nobody gets it** (give up on a
  puzzle).
- **Count it as solved for…** when someone typed it right but the game didn't take it.
- **More…**: fix anyone's round money or total, give the turn to someone, remove a player,
  skip to the final scores, or end the game.

Without a host the game still runs itself: if a player's phone drops in the middle of their
turn, the game moves on after 20 seconds.

## If the server restarts mid-game

Nothing is lost. The TV keeps a sealed copy of the game and hands it back when the server
returns; every screen says "Reconnecting…" for a moment (about a minute on a free host) and then
carries on. Keep the TV page open: the copy lives in that browser.

## Running it

Needs Node.js 18 or newer.

    npm install
    npm start

Then open http://localhost:3000/tv. To play over home Wi-Fi without hosting, phones can join at
`http://YOUR-COMPUTER-IP:3000`.

`npm test` plays a whole game against the server with scripted screens, checks the rules, checks
that every built-in puzzle fits the board, and checks that a game survives a restart.

## Hosting it for free (Render)

1. Put these files in a GitHub repository (everything except `node_modules`).
2. At render.com choose **New > Web Service**, connect the repository, and pick the **Free**
   instance type. Build command `npm install`, start command `node server.js`.
3. Render gives you an address like `friend-wheel.onrender.com`. That's `YOUR-SITE`.

A free Render service goes to sleep after 15 minutes with nobody on it and takes about a minute
to wake up, so open the TV page a few minutes before the party. The copy the TV keeps is locked
with a key only your server has; on Render the key comes from the service's own id, so there is
nothing to set up. To use a key of your own instead, add an environment variable named
`BACKUP_KEY` with any long random text.

## Changing things

- Game name: `F.TITLE` at the top of `common.js`.
- Built-in puzzles: `puzzles.js`. Each pack is a list of `[category, puzzle]`.
- Wheel values, vowel price, toss-up values, clocks: the "rules" block at the top of `server.js`.
- The board's shape and the typo rule: `board.js`.

All the sounds are synthesized in the browser, so there are no audio files.

## What changed, and when

See [CHANGELOG.md](CHANGELOG.md). The version number on the TV start screen and the phone join
screen matches the entries there.
