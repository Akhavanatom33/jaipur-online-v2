/**
 * Transport-agnostic room logic: creating/joining rooms, seats, reconnection,
 * and routing validated actions to the engine. Socket.IO lives in ../socket.
 */
import type { PlayerIndex, RoomView } from '../../shared/types.ts';
import { isRoomCodeFormat, normalizeRoomCode, type ErrorCode } from '../../shared/protocol.ts';
import { MAX_MISSED_TURNS, TURN_SECONDS } from '../../shared/constants.ts';
import { applyAction, createGame, createRematch, forfeitGame, skipTurn, startNextRound } from '../game/engine.ts';
import { cryptoRng, type Rng } from '../game/rng.ts';
import { toGameView } from '../game/view.ts';
import { other } from '../game/state.ts';
import { generateRoomCode, generateSeatToken } from './codes.ts';
import type { RoomStore } from './store.ts';
import type { Room, RoomPlayer } from './types.ts';

export type Fail = { ok: false; error: string; code: ErrorCode };
export type Result<T extends object> = ({ ok: true } & T) | Fail;

export interface SeatResult {
  room: Room;
  seat: PlayerIndex;
  token: string;
  /** Other rooms touched (e.g. the socket left a previous room). */
  affected: Room[];
}

export interface RoomManagerOptions {
  rng?: Rng;
  now?: () => number;
  /** Delete a room once every seated player has been gone this long. */
  abandonedTtlMs?: number;
  /** Length of one turn. Defaults to TURN_SECONDS. */
  turnMs?: number;
}

const fail = (code: ErrorCode, error: string): Fail => ({ ok: false, code, error });

export function cleanName(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.replace(/[-\u001f<>]/g, '').trim().slice(0, 18) : '';
  return s || fallback;
}

export class RoomManager {
  private store: RoomStore;
  private rng: Rng;
  private now: () => number;
  private abandonedTtlMs: number;
  private turnMs: number;
  private bySocket = new Map<string, { roomId: string; seat: PlayerIndex }>();
  private byUser = new Map<string, { roomId: string; seat: PlayerIndex }>();

  constructor(store: RoomStore, opts: RoomManagerOptions = {}) {
    this.store = store;
    this.rng = opts.rng ?? cryptoRng;
    this.now = opts.now ?? Date.now;
    this.abandonedTtlMs = opts.abandonedTtlMs ?? 30 * 60_000;
    this.turnMs = opts.turnMs ?? TURN_SECONDS * 1000;
  }

  getRoom(id: string) { return this.store.get(id); }
  roomOf(socketId: string) {
    const e = this.bySocket.get(socketId);
    return e ? { room: this.store.get(e.roomId), seat: e.seat } : null;
  }

  createRoom(userId: string, name: unknown, socketId: string): Result<SeatResult> {
    const existing = this.byUser.get(userId);
    if (existing && this.store.get(existing.roomId)) return fail('ALREADY_IN_ROOM', 'You already have an open room. Leave it before creating another one.');
    const affected = this.detach(socketId);
    const id = generateRoomCode((c) => this.store.has(c));
    const token = generateSeatToken();
    const t = this.now();
    const room: Room = {
      id, createdAt: t, updatedAt: t,
      players: [this.newPlayer(userId, token, cleanName(name, 'Player 1'), socketId), null],
      game: null,
      ready: [false, false],
      gameRecordId: null,
      turnDeadline: null,
      missed: [0, 0],
    };
    this.store.set(room);
    this.bySocket.set(socketId, { roomId: id, seat: 0 });
    this.byUser.set(userId, { roomId: id, seat: 0 });
    return { ok: true, room, seat: 0, token, affected };
  }

  joinRoom(userId: string, name: unknown, code: unknown, socketId: string): Result<SeatResult> {
    const existing = this.byUser.get(userId);
    if (existing && this.store.get(existing.roomId)) return fail('ALREADY_IN_ROOM', 'You already have an open room. Leave it before joining another one.');
    const id = normalizeRoomCode(String(code ?? ''));
    if (!isRoomCodeFormat(id)) return fail('INVALID_CODE', 'Room codes are 5 letters or digits, like K7P4X.');
    const room = this.store.get(id);
    if (!room) return fail('ROOM_NOT_FOUND', `No open room with code ${id}. Check the code with your opponent.`);
    const current = this.bySocket.get(socketId);
    if (current?.roomId === id) return fail('ALREADY_IN_ROOM', 'You are already in this room.');
    if (room.players[1] !== null) return fail('ROOM_FULL', `Room ${id} already has two players.`);

    const affected = this.detach(socketId);
    const token = generateSeatToken();
    room.players[1] = this.newPlayer(userId, token, cleanName(name, 'Player 2'), socketId);
    room.game = createGame(this.rng); // starts automatically once both seats are filled
    room.ready = [false, false];
    room.gameRecordId = null;
    room.missed = [0, 0];
    this.armTurn(room);
    room.updatedAt = this.now();
    this.store.set(room);
    this.bySocket.set(socketId, { roomId: id, seat: 1 });
    this.byUser.set(userId, { roomId: id, seat: 1 });
    return { ok: true, room, seat: 1, token, affected };
  }

  rejoinRoom(userId: string, code: unknown, token: unknown, socketId: string): Result<SeatResult> {
    const id = normalizeRoomCode(String(code ?? ''));
    const room = this.store.get(id);
    if (!room || typeof token !== 'string') return fail('SESSION_EXPIRED', 'That game is no longer available.');
    const seat = room.players.findIndex((p) => p?.token === token);
    if (seat === -1) return fail('SESSION_EXPIRED', 'That seat is no longer yours.');
    const p = room.players[seat]!;
    if (p.userId !== userId) return fail('SESSION_EXPIRED', 'That seat belongs to another account.');
    if (p.left) return fail('SESSION_EXPIRED', 'You left that game.');

    const affected = this.bySocket.get(socketId)?.roomId === id ? [] : this.detach(socketId);
    if (p.socketId && p.socketId !== socketId) this.bySocket.delete(p.socketId); // stale tab/socket loses the seat
    p.socketId = socketId;
    p.connected = true;
    p.lastSeen = this.now();
    room.updatedAt = this.now();
    if (room.game?.phase === 'playing' && room.turnDeadline == null) this.armTurn(room); // clock resumes when someone returns
    this.bySocket.set(socketId, { roomId: id, seat: seat as PlayerIndex });
    this.byUser.set(userId, { roomId: id, seat: seat as PlayerIndex });
    this.store.set(room);
    return { ok: true, room, seat: seat as PlayerIndex, token, affected };
  }

  /** Temporary disconnect: the seat is kept for reconnection. */
  handleDisconnect(socketId: string): Room | null {
    const e = this.bySocket.get(socketId);
    if (!e) return null;
    this.bySocket.delete(socketId);
    const room = this.store.get(e.roomId);
    const p = room?.players[e.seat];
    if (!room || !p || p.socketId !== socketId) return null;
    p.socketId = null;
    p.connected = false;
    p.lastSeen = this.now();
    room.updatedAt = this.now();
    this.store.set(room);
    return room;
  }

  /** Deliberate leave. Returns the room if it still exists (so the opponent can be told). */
  leaveRoom(socketId: string): Room | null {
    return this.detach(socketId)[0] ?? null;
  }

  act(socketId: string, action: unknown): Result<{ room: Room }> {
    const found = this.seatOf(socketId);
    if (!found.ok) return found;
    const { room, seat } = found;
    if (!room.game) return fail('GAME_NOT_STARTED', 'Waiting for a second player.');
    const res = applyAction(room.game, seat, action);
    if (!res.ok) return fail('ILLEGAL_ACTION', res.error);
    room.ready = [false, false];
    this.missedOf(room)[seat] = 0;
    this.armTurn(room);
    room.updatedAt = this.now();
    this.store.set(room);
    return { ok: true, room };
  }

  /** Vote to continue (next round or rematch). Proceeds when both players agree. */
  continueGame(socketId: string): Result<{ room: Room; advanced: boolean }> {
    const found = this.seatOf(socketId);
    if (!found.ok) return found;
    const { room, seat } = found;
    const g = room.game;
    if (!g || g.phase === 'playing') return fail('ILLEGAL_ACTION', 'Nothing to continue right now.');
    const opp = room.players[seat === 0 ? 1 : 0];
    if (!opp || opp.left) return fail('ILLEGAL_ACTION', 'Your opponent has left the room.');
    room.ready[seat] = true;
    let advanced = false;
    if (room.ready[0] && room.ready[1]) {
      if (g.phase === 'roundOver') startNextRound(g, this.rng);
      else room.game = createRematch(g, this.rng);
      room.ready = [false, false];
      room.missed = [0, 0];
      this.armTurn(room);
      advanced = true;
    }
    room.updatedAt = this.now();
    this.store.set(room);
    return { ok: true, room, advanced };
  }

  viewFor(room: Room, seat: PlayerIndex): RoomView {
    const pv = (p: RoomPlayer | null) => (p ? { name: p.name, connected: p.connected, left: p.left } : null);
    return {
      roomId: room.id,
      you: seat,
      players: [pv(room.players[0]), pv(room.players[1])],
      status: room.game ? room.game.phase : 'waiting',
      ready: [room.ready[0], room.ready[1]],
      missed: [room.missed?.[0] ?? 0, room.missed?.[1] ?? 0],
      turn: room.game?.phase === 'playing' && room.turnDeadline
        ? { deadline: room.turnDeadline, durationMs: this.turnMs, serverNow: this.now() }
        : null,
      game: room.game ? toGameView(room.game, seat) : null,
    };
  }

  // ---- turn clock ---------------------------------------------------------

  /** Earliest running turn deadline across all rooms (for scheduling an alarm). */
  nextDeadline(): number | null {
    let next: number | null = null;
    for (const room of this.store.values()) {
      if (room.game?.phase !== 'playing' || room.turnDeadline == null) continue;
      if (next === null || room.turnDeadline < next) next = room.turnDeadline;
    }
    return next;
  }

  /**
   * Apply every expired turn: the player loses the turn, and after
   * MAX_MISSED_TURNS in a row forfeits the game. Returns the rooms that changed.
   * If nobody is connected the clock is paused until someone comes back.
   */
  expireTurns(): Room[] {
    const t = this.now();
    const changed: Room[] = [];
    for (const room of [...this.store.values()]) {
      const g = room.game;
      if (!g || g.phase !== 'playing') { room.turnDeadline = null; continue; }
      if (room.turnDeadline == null || t < room.turnDeadline) continue;
      const seat = g.round.currentPlayer;
      const me = room.players[seat];
      const opp = room.players[other(seat)];
      if (!me || !opp) { room.turnDeadline = null; continue; }
      if (!me.connected && !opp.connected) { room.turnDeadline = null; this.store.set(room); continue; }
      const missed = this.missedOf(room);
      missed[seat]++;
      skipTurn(g, seat, missed[seat]);
      if (missed[seat] >= MAX_MISSED_TURNS) forfeitGame(g, seat);
      room.ready = [false, false];
      this.armTurn(room);
      room.updatedAt = t;
      this.store.set(room);
      changed.push(room);
    }
    return changed;
  }

  /** Rebuild the user/socket indexes after rooms were loaded from durable storage. */
  restoreIndex() {
    this.bySocket.clear();
    this.byUser.clear();
    for (const room of this.store.values()) {
      room.missed ??= [0, 0];
      room.players.forEach((p, seat) => {
        if (p && !p.left) this.byUser.set(p.userId, { roomId: room.id, seat: seat as PlayerIndex });
      });
      this.armTurn(room);
    }
  }

  /** Remove abandoned rooms. Returns deleted ids. */
  sweep(): string[] {
    const t = this.now();
    const deleted: string[] = [];
    for (const room of [...this.store.values()]) {
      const seated = room.players.filter((p): p is RoomPlayer => p !== null);
      const anyoneHere = seated.some((p) => p.connected);
      const lastSeen = Math.max(...seated.map((p) => (p.connected ? t : p.lastSeen)));
      if (!anyoneHere && t - lastSeen > this.abandonedTtlMs) {
        for (const p of room.players) if (p) this.byUser.delete(p.userId);
        this.store.delete(room.id);
        deleted.push(room.id);
      }
    }
    return deleted;
  }

  activeRoomCount() { return this.store.size(); }

  // -------------------------------------------------------------------------

  private missedOf(room: Room): [number, number] {
    return (room.missed ??= [0, 0]);
  }

  /** Start a fresh clock for whoever has to move now (or stop it outside of play). */
  private armTurn(room: Room) {
    const playing = room.game?.phase === 'playing' && room.players[0] !== null && room.players[1] !== null;
    room.turnDeadline = playing ? this.now() + this.turnMs : null;
  }

  private newPlayer(userId: string, token: string, name: string, socketId: string): RoomPlayer {
    return { userId, token, name, socketId, connected: true, left: false, lastSeen: this.now() };
  }

  private seatOf(socketId: string): Result<{ room: Room; seat: PlayerIndex }> {
    const e = this.bySocket.get(socketId);
    const room = e && this.store.get(e.roomId);
    if (!e || !room) return fail('NOT_IN_ROOM', 'You are not in a room.');
    return { ok: true, room, seat: e.seat };
  }

  /** Remove a socket from whatever room it occupies. */
  private detach(socketId: string): Room[] {
    const e = this.bySocket.get(socketId);
    if (!e) return [];
    this.bySocket.delete(socketId);
    const room = this.store.get(e.roomId);
    const p = room?.players[e.seat];
    if (!room || !p) return [];
    p.left = true;
    p.connected = false;
    p.socketId = null;
    p.lastSeen = this.now();
    const everyoneLeft = room.players.every((x) => x === null || x.left);
    if (!room.game || everyoneLeft) {
      // A waiting room closes when its creator leaves; a game closes when both leave.
      for (const x of room.players) { if (x?.socketId) this.bySocket.delete(x.socketId); if (x?.userId) this.byUser.delete(x.userId); }
      this.store.delete(room.id);
      return room.game ? [] : room.players[1] ? [room] : [];
    }
    this.byUser.delete(p.userId);
    room.updatedAt = this.now();
    this.store.set(room);
    return [room];
  }
}
