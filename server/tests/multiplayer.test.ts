import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, forfeitGame, startNextRound, skipTurn } from '../game/engine.ts';
import { seededRng } from '../game/rng.ts';
import { toGameView } from '../game/view.ts';
import { RoomManager } from '../rooms/RoomManager.ts';
import { MemoryRoomStore } from '../rooms/store.ts';
import { CARD_TYPES, TURN_SECONDS, modeConfig } from '../../shared/constants.ts';
import type { GameMode, PlayerIndex } from '../../shared/types.ts';
import { randomLegalAction } from './helpers.ts';

const total = (mode: GameMode) => CARD_TYPES.reduce((s, t) => s + modeConfig(mode).cardCounts[t], 0);

test('turn clock is 20 seconds', () => {
  assert.equal(TURN_SECONDS, 20);
});

test('3 and 4 player decks are bigger than the classic 55 cards', () => {
  assert.equal(total(2), 55);
  assert.ok(total(3) > 55 && total(4) > total(3));
  for (const mode of [3, 4] as GameMode[]) {
    const s = createGame(seededRng(5), 0, mode);
    const r = s.round;
    const cards = r.deck.length + r.market.length + r.players.reduce((n, p) => n + p.hand.length + p.herd.length, 0);
    assert.equal(cards, total(mode));
    assert.equal(r.market.length, modeConfig(mode).marketSize);
    assert.equal(r.players.length, mode);
  }
});

test('turn order is clockwise across all seats', () => {
  for (const mode of [3, 4] as GameMode[]) {
    const s = createGame(seededRng(9), 0, mode);
    const seen: number[] = [];
    for (let i = 0; i < mode * 2; i++) {
      seen.push(s.round.currentPlayer);
      assert.equal(skipTurn(s, s.round.currentPlayer, 1).ok, true);
    }
    assert.deepEqual(seen, Array.from({ length: mode * 2 }, (_, i) => i % mode));
  }
});

test('simulation: random 3 and 4 player games always finish within 3 rounds', () => {
  for (const mode of [3, 4] as GameMode[]) {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = seededRng(seed * 7);
      const s = createGame(rng, undefined, mode);
      let guard = 0;
      while (s.phase !== 'gameOver') {
        if (guard++ > 20000) assert.fail('game did not finish');
        if (s.phase === 'roundOver') { startNextRound(s, rng); continue; }
        assert.equal(applyAction(s, s.round.currentPlayer, randomLegalAction(s, rng)).ok, true);
        const cards = s.round.deck.length + s.round.market.length + s.round.discard.length
          + s.round.players.reduce((n, p) => n + p.hand.length + p.herd.length, 0);
        assert.equal(cards, total(mode));
      }
      assert.ok(s.results.length <= 3);
      assert.notEqual(s.winner, null);
    }
  }
});

test('views list every opponent and hide their cards', () => {
  const s = createGame(seededRng(3), 1, 4);
  const v = toGameView(s, 2);
  assert.deepEqual(v.opponents.map((o) => o.seat), [3, 0, 1]);
  const json = JSON.stringify(v);
  for (const seat of [0, 1, 3]) for (const c of s.round.players[seat].hand) assert.ok(!json.includes(`"${c.id}"`));
});

test('forfeit in a 3 player game removes only that player', () => {
  const s = createGame(seededRng(2), 0, 3);
  assert.equal(forfeitGame(s, 0).ok, true);
  assert.equal(s.phase, 'playing');
  assert.equal(s.round.currentPlayer, 1);
  assert.equal(forfeitGame(s, 1).ok, true);
  assert.equal(s.phase, 'gameOver');
  assert.equal(s.winner, 2);
});

const mgr = (now = () => 1000) => new RoomManager(new MemoryRoomStore(), { rng: seededRng(4), now });

test('a 4 player room starts only when all four seats are filled', () => {
  const m = mgr();
  const a = m.createRoom('a', 'A', 'sa', 4);
  assert.ok(a.ok);
  const id = a.room.id;
  for (const [i, u] of ['b', 'c'].entries()) {
    const r = m.joinRoom(u, u, id, `s${u}`);
    assert.ok(r.ok);
    assert.equal(r.seat, i + 1);
    assert.equal(r.room.game, null);
  }
  const d = m.joinRoom('d', 'D', id, 'sd');
  assert.ok(d.ok && d.room.game);
  assert.equal(d.room.game!.round.players.length, 4);
  const e = m.joinRoom('e', 'E', id, 'se');
  assert.ok(!e.ok && e.code === 'ROOM_FULL');
});

test('leaving a waiting room frees the seat', () => {
  const m = mgr();
  const a = m.createRoom('a', 'A', 'sa', 3);
  assert.ok(a.ok);
  const b = m.joinRoom('b', 'B', a.room.id, 'sb');
  assert.ok(b.ok);
  m.leaveRoom('sb');
  assert.equal(a.room.players[1], null);
  const c = m.joinRoom('c', 'C', a.room.id, 'sc');
  assert.ok(c.ok && c.seat === 1);
});

test('chat: trimmed, limited, rate limited and kept for rejoin', () => {
  let t = 1000;
  const m = mgr(() => t);
  const a = m.createRoom('a', 'Asha', 'sa');
  assert.ok(a.ok);
  const r = m.chat('sa', '  سلام   دنیا \n ');
  assert.ok(r.ok);
  assert.equal(r.message.text, 'سلام دنیا');
  assert.equal(r.message.name, 'Asha');
  const fast = m.chat('sa', 'again');
  assert.ok(!fast.ok && fast.code === 'RATE_LIMITED');
  t += 1000;
  const long = m.chat('sa', 'x'.repeat(5000));
  assert.ok(long.ok && long.message.text.length === 300);
  assert.equal(m.chatHistory(a.room).length, 2);
  assert.ok(!m.chat('nobody', 'hi').ok);
});

test('voice: signalling only between members of the same voice channel', () => {
  const m = mgr();
  const a = m.createRoom('a', 'A', 'sa');
  assert.ok(a.ok);
  const b = m.joinRoom('b', 'B', a.room.id, 'sb');
  assert.ok(b.ok);
  const other = m.createRoom('x', 'X', 'sx');
  assert.ok(other.ok);
  assert.ok(!m.voiceRoute('sa', 1).ok, 'peer not in voice yet');
  m.voiceJoin('sa'); m.voiceJoin('sb');
  assert.deepEqual(m.voiceSeats(a.room), [0, 1]);
  const route = m.voiceRoute('sa', 1);
  assert.ok(route.ok && route.toSocketId === 'sb' && route.from === 0);
  assert.ok(!m.voiceRoute('sa', 0).ok, 'cannot signal yourself');
  assert.ok(!m.voiceRoute('sx', 1).ok, 'other rooms are unreachable');
  m.handleDisconnect('sb');
  assert.deepEqual(m.voiceSeats(a.room), [0]);
});

test('leaving a running 2 player game ends it at once', () => {
  const m = mgr();
  const a = m.createRoom('a', 'A', 'sa');
  assert.ok(a.ok);
  const b = m.joinRoom('b', 'B', a.room.id, 'sb');
  assert.ok(b.ok);
  m.leaveRoom('sb');
  assert.equal(a.room.game!.phase, 'gameOver');
  assert.equal(a.room.game!.winner as PlayerIndex, 0);
});
