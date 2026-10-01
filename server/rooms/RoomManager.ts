/**
 * Transport-agnostic room logic: creating/joining rooms, seats, reconnection,
 * chat, voice signalling routes and routing validated actions to the engine.
 * The WebSocket transport lives in worker/index.ts.
 *
 * A room has 2, 3 or 4 seats (its "mode"). The game starts automatically as
 * soon as every seat is taken.
 */
import type { ChatMessage, GameMode, PlayerIndex, RoomView } from '../../shared/types.ts';
import { CHAT_MAX_LENGTH, isRoomCodeFormat, normalizeRoomCode, type ErrorCode } from '../../shared/protocol.ts';
import { MAX_MISSED_TURNS, TURN_SECONDS, parseMode } from '../../shared/constants.ts';
import { applyAction, createGame, createRematch, forfeitGame, skipTurn, startNextRound } from '../game/engine.ts';
import { cryptoRng, type Rng } from '../game/rng.ts';
import { toGameView } from '../game/view.ts';
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

const CHAT_KEEP = 100;
const CHAT_GAP_MS = 350;

export function cleanName(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.replace(/[-\u001f<>]/g, '').trim().slice(0, 18) : '';
  return s || fallback;
}

/** Chat text: no control characters, collapsed whitespace, limited length. */
export function cleanChat(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
}

export const roomMode = (room: Room): GameMode => (room.mode ?? (room.players.length as GameMode));
const flags = (n: number, v: boolean) => Array.from({ length: n }, () => v);

export class RoomManager {
  private store: RoomStore;
  private rng: Rng;
  private now: () => number;
  private abandonedTtlMs: number;
  private turnMs: number;
  private bySocket = new Map<string, { roomId: string; seat: PlayerIndex }>();
  private byUser = new Map<string, { roomId: string; seat: PlayerIndex }>();
  /** Voice channel members per room (seat numbers). Ephemeral: never persisted. */
  private voice = new Map<string, Set<number>>();
  private lastChat = new Map<string, number>();

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

  createRoom(userId: string, name: unknown, socketId: string, modeRaw: unknown = 2): Result<SeatResult> {
    const existing = this.byUser.get(userId);
    if (existing && this.store.get(existing.roomId)) return fail('ALREADY_IN_ROOM', 'You already have an open room. Leave it before creating another one.');
    const mode = parseMode(modeRaw);
    const affected = this.detach(socketId);
    const id = generateRoomCode((c) => this.store.has(c));
    const token = generateSeatToken();
    const t = this.now();
    const players: (RoomPlayer | null)[] = Array.from({ length: mode }, () => null);
    players[0] = this.newPlayer(userId, token, cleanName(name, 'Player 1'), socketId);
    const room: Room = {
      id, createdAt: t, updatedAt: t,
      mode,
      players,
      game: null,
      ready: flags(mode, false),
      gameRecordId: null,
      turnDeadline: null,
      missed: Array.from({ length: mode }, () => 0),
      chat: [],
      chatSeq: 0,
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
    if (!room) return fail('ROOM_NOT_FOUND', `No open room with code ${id}. Check the code with your friends.`);
    const current = this.bySocket.get(socketId);
    if (current?.roomId === id) return fail('ALREADY_IN_ROOM', 'You are already in this room.');
    const mode = roomMode(room);
    const seat = room.players.findIndex((p) => p === null);
    if (seat === -1 || room.game) return fail('ROOM_FULL', `Room ${id} already has ${mode} players.`);

    const affected = this.detach(socketId);
    const token = generateSeatToken();
    room.players[seat] = this.newPlayer(userId, token, cleanName(name, `Player ${seat + 1}`), socketId);
    if (room.players.every((p) => p !== null)) {
      // The last seat is filled: the game starts automatically.
      room.game = createGame(this.rng, undefined, mode);
      room.ready = flags(mode, false);
      room.gameRecordId = null;
      room.missed = Array.from({ length: mode }, () => 0);
      this.armTurn(room);
    }
    room.updatedAt = this.now();
    this.store.set(room);
    this.bySocket.set(socketId, { roomId: id, seat: seat as PlayerIndex });
    this.byUser.set(userId, { roomId: id, seat: seat as PlayerIndex });
    return { ok: true, room, seat: seat as PlayerIndex, token, affected };
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
    this.voice.get(room.id)?.delete(e.seat);
    this.store.set(room);
    return room;
  }

  /** Deliberate leave. Returns the room if it still exists (so the others can be told). */
  leaveRoom(socketId: string): Room | null {
    return this.detach(socketId)[0] ?? null;
  }

  act(socketId: string, action: unknown): Result<{ room: Room }> {
    const found = this.seatOf(socketId);
    if (!found.ok) return found;
    const { room, seat } = found;
    if (!room.game) return fail('GAME_NOT_STARTED', 'Waiting for the other players.');
    const res = applyAction(room.game, seat, action);
    if (!res.ok) return fail('ILLEGAL_ACTION', res.error);
    room.ready = flags(roomMode(room), false);
    this.missedOf(room)[seat] = 0;
    this.armTurn(room);
    room.updatedAt = this.now();
    this.store.set(room);
    return { ok: true, room };
  }

  /** Vote to continue (next round or rematch). Proceeds when every present player agrees. */
  continueGame(socketId: string): Result<{ room: Room; advanced: boolean }> {
    const found = this.seatOf(socketId);
    if (!found.ok) return found;
    const { room, seat } = found;
    const g = room.game;
    if (!g || g.phase === 'playing') return fail('ILLEGAL_ACTION', 'Nothing to continue right now.');
    if (g.phase === 'gameOver' && room.players.some((p) => !p || p.left)) return fail('ILLEGAL_ACTION', 'Your opponent has left the room.');
    room.ready[seat] = true;
    let advanced = false;
    const voters = room.players.map((p, i) => (p && !p.left ? i : -1)).filter((i) => i >= 0);
    if (voters.every((i) => room.ready[i])) {
      if (g.phase === 'roundOver') startNextRound(g, this.rng);
      else room.game = createRematch(g, this.rng);
      const mode = roomMode(room);
      room.ready = flags(mode, false);
      room.missed = Array.from({ length: mode }, () => 0);
      this.armTurn(room);
      advanced = true;
    }
    room.updatedAt = this.now();
    this.store.set(room);
    return { ok: true, room, advanced };
  }

  // ---- chat -----------------------------------------------------------------

  /** Post a chat message to the room of this socket (works in the lobby and during the game). */
  chat(socketId: string, text: unknown): Result<{ room: Room; message: ChatMessage }> {
    const found = this.seatOf(socketId);
    if (!found.ok) return found;
    const { room, seat } = found;
    const clean = cleanChat(text);
    if (!clean) return fail('BAD_REQUEST', 'Write a message first.');
    const key = `${room.id}:${seat}`;
    const t = this.now();
    const last = this.lastChat.get(key) ?? 0;
    if (t - last < CHAT_GAP_MS && t >= last) return fail('RATE_LIMITED', 'You are sending messages too fast.');
    this.lastChat.set(key, t);
    room.chatSeq = (room.chatSeq ?? 0) + 1;
    const message: ChatMessage = { id: room.chatSeq, seat, name: room.players[seat]?.name ?? `Player ${seat + 1}`, text: clean, at: t };
    room.chat = [...(room.chat ?? []), message].slice(-CHAT_KEEP);
    room.updatedAt = t;
    this.store.set(room);
    return { ok: true, room, message };
  }

  chatHistory(room: Room): ChatMessage[] {
    return (room.chat ?? []).slice();
  }

  // ---- voice (WebRTC signalling) --------------------------------------------

  voiceSeats(room: Room): number[] {
    return [...(this.voice.get(room.id) ?? [])].sort((a, b) => a - b);
  }

  voiceJoin(socketId: string): Result<{ room: Room }> {
    const found = this.seatOf(socketId);
    if (!found.ok) return found;
    const set = this.voice.get(found.room.id) ?? new Set<number>();
    set.add(found.seat);
    this.voice.set(found.room.id, set);
    return { ok: true, room: found.room };
  }

  voiceLeave(socketId: string): Result<{ room: Room }> {
    const found = this.seatOf(socketId);
    if (!found.ok) return found;
    this.voice.get(found.room.id)?.delete(found.seat);
    return { ok: true, room: found.room };
  }

  /** Where should a signalling message from this socket go? Both seats must be in the voice channel. */
  voiceRoute(socketId: string, to: unknown): Result<{ from: PlayerIndex; toSocketId: string }> {
    const found = this.seatOf(socketId);
    if (!found.ok) return found;
    const { room, seat } = found;
    const members = this.voice.get(room.id);
    if (typeof to !== 'number' || !Number.isInteger(to) || to === seat || !members?.has(seat) || !members.has(to)) {
      return fail('BAD_REQUEST', 'That player is not in the voice channel.');
    }
    const target = room.players[to];
    if (!target?.socketId) return fail('BAD_REQUEST', 'That player is offline.');
    return { ok: true, from: seat, toSocketId: target.socketId };
  }

  viewFor(room: Room, seat: PlayerIndex): RoomView {
    const mode = roomMode(room);
    const pv = (p: RoomPlayer | null) => (p ? { name: p.name, connected: p.connected, left: p.left } : null);
    return {
      roomId: room.id,
      you: seat,
      mode,
      players: room.players.map(pv),
      status: room.game ? room.game.phase : 'waiting',
      ready: Array.from({ length: mode }, (_, i) => Boolean(room.ready[i])),
      missed: Array.from({ length: mode }, (_, i) => room.missed?.[i] ?? 0),
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
   * MAX_MISSED_TURNS in a row forfeits. Returns the rooms that changed.
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
      if (room.players.some((p) => !p)) { room.turnDeadline = null; continue; }
      if (!room.players.some((p) => p?.connected)) { room.turnDeadline = null; this.store.set(room); continue; }
      const missed = this.missedOf(room);
      missed[seat]++;
      skipTurn(g, seat, missed[seat]);
      if (missed[seat] >= MAX_MISSED_TURNS) forfeitGame(g, seat);
      room.ready = flags(roomMode(room), false);
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
    this.voice.clear();
    for (const room of this.store.values()) {
      room.missed ??= flags(roomMode(room), false).map(() => 0);
      room.chat ??= [];
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
      const lastSeen = Math.max(0, ...seated.map((p) => (p.connected ? t : p.lastSeen)));
      if (!anyoneHere && t - lastSeen > this.abandonedTtlMs) {
        this.dropRoom(room);
        deleted.push(room.id);
      }
    }
    return deleted;
  }

  activeRoomCount() { return this.store.size(); }

  // -------------------------------------------------------------------------

  private dropRoom(room: Room) {
    for (const p of room.players) {
      if (!p) continue;
      this.byUser.delete(p.userId);
      if (p.socketId) this.bySocket.delete(p.socketId);
    }
    this.voice.delete(room.id);
    this.store.delete(room.id);
  }

  private missedOf(room: Room): number[] {
    return (room.missed ??= Array.from({ length: roomMode(room) }, () => 0));
  }

  /** Start a fresh clock for whoever has to move now (or stop it outside of play). */
  private armTurn(room: Room) {
    const playing = room.game?.phase === 'playing' && room.players.every((p) => p !== null);
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

  /**
   * Remove a socket from whatever room it occupies.
   * - Waiting room: the seat is simply freed (the room closes when it is empty).
   * - Running game: leaving counts as a forfeit (2 players: the opponent wins; 3-4: the player is out).
   */
  private detach(socketId: string): Room[] {
    const e = this.bySocket.get(socketId);
    if (!e) return [];
    this.bySocket.delete(socketId);
    const room = this.store.get(e.roomId);
    const p = room?.players[e.seat];
    if (!room || !p) return [];
    this.voice.get(room.id)?.delete(e.seat);

    if (!room.game) {
      room.players[e.seat] = null;
      this.byUser.delete(p.userId);
      if (room.players.every((x) => x === null)) {
        this.dropRoom(room);
        return [];
      }
      room.ready = flags(roomMode(room), false);
      room.updatedAt = this.now();
      this.store.set(room);
      return [room];
    }

    p.left = true;
    p.connected = false;
    p.socketId = null;
    p.lastSeen = this.now();
    const everyoneLeft = room.players.every((x) => x === null || x.left);
    if (everyoneLeft) {
      this.dropRoom(room);
      return [];
    }
    this.byUser.delete(p.userId);
    if (room.game.phase !== 'gameOver') {
      forfeitGame(room.game, e.seat);
      room.ready = flags(roomMode(room), false);
      this.armTurn(room);
    }
    room.updatedAt = this.now();
    this.store.set(room);
    return [room];
  }
}
