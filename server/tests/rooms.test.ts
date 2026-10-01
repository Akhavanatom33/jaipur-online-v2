import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../rooms/RoomManager.ts';
import { MemoryRoomStore } from '../rooms/store.ts';
import { seededRng } from '../game/rng.ts';
import { endRound } from '../game/engine.ts';
import { isRoomCodeFormat } from '../../shared/protocol.ts';

const mgr = (now = () => 1000) => new RoomManager(new MemoryRoomStore(), { rng: seededRng(4), now, abandonedTtlMs: 60_000 });

test('create room: unique, well-formed codes', () => {
  const m = mgr();
  const codes = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const r = m.createRoom(`user${i}`, 'A', `s${i}`);
    assert.ok(r.ok);
    assert.ok(isRoomCodeFormat(r.room.id));
    codes.add(r.room.id);
  }
  assert.equal(codes.size, 2000);
});

test('join the exact room; third player, bad and unknown codes are rejected', () => {
  const m = mgr();
  const a = m.createRoom('userA', 'Asha', 'sa');
  const b = m.createRoom('userB', 'Bo', 'sb');
  assert.ok(a.ok && b.ok);
  const j = m.joinRoom('userC', 'Chandra', a.room.id.toLowerCase(), 'sc');
  assert.ok(j.ok);
  assert.equal(j.room.id, a.room.id);
  assert.equal(j.seat, 1);
  assert.ok(j.room.game, 'game starts on join');
  assert.equal(m.getRoom(b.room.id)!.game, null, 'other room untouched');
  const third = m.joinRoom('userD', 'Dev', a.room.id, 'sd');
  assert.equal(third.ok, false);
  assert.equal(!third.ok && third.code, 'ROOM_FULL');
  const bad = m.joinRoom('userD2', 'Dev', '!!', 'sd');
  assert.equal(!bad.ok && bad.code, 'INVALID_CODE');
  const unknown = m.joinRoom('userD3', 'Dev', 'ZZZZZ', 'sd');
  assert.equal(!unknown.ok && unknown.code, 'ROOM_NOT_FOUND');
  const self = m.joinRoom('userB', 'Bo', b.room.id, 'sb');
  assert.equal(!self.ok && self.code, 'ALREADY_IN_ROOM');
});

test('two rooms run independent games simultaneously', () => {
  const m = mgr();
  const a = m.createRoom('userA1', 'A1', 'a1'); const b = m.createRoom('userB1', 'B1', 'b1');
  assert.ok(a.ok && b.ok);
  m.joinRoom('userA2', 'A2', a.room.id, 'a2'); m.joinRoom('userB2', 'B2', b.room.id, 'b2');
  const ga = m.getRoom(a.room.id)!.game!; const gb = m.getRoom(b.room.id)!.game!;
  assert.notEqual(ga, gb);
  const beforeB = JSON.stringify(gb);
  const sockA = ga.round.currentPlayer === 0 ? 'a1' : 'a2';
  const res = m.act(sockA, { type: 'takeCamels' });
  assert.ok(res.ok);
  assert.equal(ga.version, 2);
  assert.equal(JSON.stringify(gb), beforeB);
  // A player of room B cannot act in room A
  const wrong = m.act('b1', { type: 'takeCamels' });
  assert.ok(wrong.ok === false || m.getRoom(a.room.id)!.game!.version === 2);
});

test('turn enforcement through the room layer', () => {
  const m = mgr();
  const a = m.createRoom('userX1', 'A', 'x1'); assert.ok(a.ok);
  m.joinRoom('userX2', 'B', a.room.id, 'x2');
  const g = m.getRoom(a.room.id)!.game!;
  const idle = g.round.currentPlayer === 0 ? 'x2' : 'x1';
  const r = m.act(idle, { type: 'takeCamels' });
  assert.equal(r.ok, false);
  assert.equal(m.act('nobody', { type: 'takeCamels' }).ok, false);
});

test('disconnect keeps the seat; token reclaims it; wrong token fails', () => {
  let t = 1000;
  const m = mgr(() => t);
  const a = m.createRoom('userP1', 'A', 'p1'); assert.ok(a.ok);
  const b = m.joinRoom('userP2', 'B', a.room.id, 'p2'); assert.ok(b.ok);
  const room = m.handleDisconnect('p2')!;
  assert.equal(room.players[1]!.connected, false);
  assert.equal(m.viewFor(room, 0).players[1]!.connected, false);
  assert.equal(m.rejoinRoom('userP2', a.room.id, 'forged', 'p2b').ok, false);
  const back = m.rejoinRoom('userP2', a.room.id, b.token, 'p2b');
  assert.ok(back.ok);
  assert.equal(back.seat, 1);
  assert.equal(back.room.players[1]!.connected, true);
  assert.ok(m.viewFor(back.room, 1).game!.me.hand.length >= 0);
  // Abandoned rooms are swept only after both are gone for the TTL
  m.handleDisconnect('p1'); m.handleDisconnect('p2b');
  t += 30_000; assert.deepEqual(m.sweep(), []);
  t += 60_000; assert.deepEqual(m.sweep(), [a.room.id]);
});

test('leaving: waiting room closes; mid-game leave is shown to the opponent', () => {
  const m = mgr();
  const a = m.createRoom('userQ1', 'A', 'q1'); assert.ok(a.ok);
  m.leaveRoom('q1');
  assert.equal(m.getRoom(a.room.id), undefined);
  const b = m.createRoom('userQ1', 'A', 'q1'); assert.ok(b.ok);
  m.joinRoom('userQ2', 'B', b.room.id, 'q2');
  const r = m.leaveRoom('q2')!;
  assert.equal(m.viewFor(r, 0).players[1]!.left, true);
  assert.equal(m.continueGame('q1').ok, false);
  m.leaveRoom('q1');
  assert.equal(m.getRoom(b.room.id), undefined);
});

test('continue: both players must agree to start the next round', () => {
  const m = mgr();
  const a = m.createRoom('userR1', 'A', 'r1'); assert.ok(a.ok);
  m.joinRoom('userR2', 'B', a.room.id, 'r2');
  const room = m.getRoom(a.room.id)!;
  assert.equal(m.continueGame('r1').ok, false, 'nothing to continue mid-round');
  room.game!.round.players[0].goodsTokens.push({ id: 'z', good: 'gold', value: 6 });
  endRound(room.game!, 'deck');
  const first = m.continueGame('r1');
  assert.ok(first.ok && !first.advanced);
  assert.deepEqual(m.viewFor(room, 1).ready, [true, false]);
  const second = m.continueGame('r2');
  assert.ok(second.ok && second.advanced);
  assert.equal(room.game!.round.number, 2);
  assert.equal(room.game!.phase, 'playing');
});

test('views are per-seat: nobody receives the other hand', () => {
  const m = mgr();
  const a = m.createRoom('userV1', 'A', 'v1'); assert.ok(a.ok);
  m.joinRoom('userV2', 'B', a.room.id, 'v2');
  const room = m.getRoom(a.room.id)!;
  for (const seat of [0, 1] as const) {
    const json = JSON.stringify(m.viewFor(room, seat));
    for (const c of room.game!.round.players[seat === 0 ? 1 : 0].hand) assert.ok(!json.includes(`"${c.id}"`));
    assert.ok(!json.includes('token":"'), 'seat tokens never sent');
  }
});

// ---------------------------------------------------------------------------
// Turn clock
// ---------------------------------------------------------------------------

const clocked = () => {
  const clock = { t: 1000 };
  const m = new RoomManager(new MemoryRoomStore(), { rng: seededRng(4), now: () => clock.t, turnMs: 10_000 });
  const a = m.createRoom('userA', 'Asha', 'sa');
  assert.ok(a.ok);
  const b = m.joinRoom('userB', 'Bo', a.room.id, 'sb');
  assert.ok(b.ok);
  return { clock, m, room: m.getRoom(a.room.id)!, tokenA: a.token };
};

test('turn clock: starts with the game and an expired turn passes to the opponent', () => {
  const { clock, m, room } = clocked();
  const first = room.game!.round.currentPlayer;
  assert.equal(room.turnDeadline, 11_000);
  clock.t = 10_999;
  assert.equal(m.expireTurns().length, 0, 'not expired yet');
  assert.equal(m.nextDeadline(), 11_000);
  clock.t = 11_001;
  const changed = m.expireTurns();
  assert.equal(changed.length, 1);
  assert.notEqual(room.game!.round.currentPlayer, first, 'the turn moved on');
  assert.equal(room.missed![first], 1);
  assert.equal(room.game!.lastEvent?.type, 'timeout');
  assert.equal(room.turnDeadline, 21_001, 'a fresh clock starts for the next player');
  assert.equal(m.viewFor(room, first).turn?.deadline, 21_001);
});

test('turn clock: a real action resets the miss counter and the clock', () => {
  const { clock, m, room } = clocked();
  const first = room.game!.round.currentPlayer;
  clock.t = 11_001;
  m.expireTurns();
  const next = room.game!.round.currentPlayer;
  clock.t = 15_000;
  const res = m.act(next === 0 ? 'sa' : 'sb', { type: 'takeCamels' });
  assert.ok(res.ok, 'market starts with camels');
  assert.equal(room.missed![next], 0);
  assert.equal(room.missed![first], 1, 'the other player keeps their miss');
  assert.equal(room.turnDeadline, 25_000);
});

test('turn clock: three missed turns in a row forfeit the game', () => {
  const { clock, m, room } = clocked();
  const first = room.game!.round.currentPlayer;
  for (let i = 0; i < 5; i++) {
    clock.t = room.turnDeadline! + 1;
    m.expireTurns();
  }
  assert.equal(room.game!.phase, 'gameOver');
  assert.equal(room.game!.forfeit, first);
  assert.equal(room.game!.winner, first === 0 ? 1 : 0);
  assert.equal(room.turnDeadline, null, 'no clock after the game ended');
  assert.equal(m.viewFor(room, 0).game!.forfeit, first);
});

test('turn clock: pauses while nobody is connected and resumes on rejoin', () => {
  const { clock, m, room, tokenA } = clocked();
  m.handleDisconnect('sa');
  m.handleDisconnect('sb');
  clock.t = 99_000;
  assert.equal(m.expireTurns().length, 0);
  assert.equal(room.turnDeadline, null);
  assert.equal(room.game!.phase, 'playing');
  const back = m.rejoinRoom('userA', room.id, tokenA, 'sa2');
  assert.ok(back.ok);
  assert.equal(room.turnDeadline, 109_000);
});

test('restoreIndex: a restarted manager still knows who sits in which room', () => {
  const store = new MemoryRoomStore();
  const first = new RoomManager(store, { rng: seededRng(4), now: () => 1000, turnMs: 10_000 });
  const a = first.createRoom('userA', 'Asha', 'sa');
  assert.ok(a.ok);
  assert.ok(first.joinRoom('userB', 'Bo', a.room.id, 'sb').ok);

  // Simulate a Durable Object restart: same stored rooms, brand new in-memory indexes.
  const restarted = new RoomManager(store, { rng: seededRng(4), now: () => 2000, turnMs: 10_000 });
  const before = restarted.createRoom('userA', 'Asha', 'sx');
  assert.equal(before.ok, true, 'without restoreIndex the manager forgets the seats');
  restarted.leaveRoom('sx');
  for (const room of store.values()) for (const p of room.players) if (p) { p.socketId = null; p.connected = false; }
  restarted.restoreIndex();
  const again = restarted.createRoom('userB', 'Bo', 'sy');
  assert.equal(!again.ok && again.code, 'ALREADY_IN_ROOM');
  const back = restarted.rejoinRoom('userA', a.room.id, a.token, 'sa2');
  assert.ok(back.ok);
});
