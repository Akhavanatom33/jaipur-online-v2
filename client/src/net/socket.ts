import type { AckResult, SeatGrant } from '../../../shared/protocol.ts';
import type { GameAction } from '../../../shared/types.ts';

type Listener = (...args: any[]) => void;

class GameSocket {
  connected = false;
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private acks = new Map<number, (r: any) => void>();
  private nextId = 1;
  private retry = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.open();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.wake);
      document.addEventListener('visibilitychange', this.wake);
    }
  }

  stop() {
    this.started = false;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    this.acks.clear();
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) { try { ws.close(1000, 'logout'); } catch { /* ignore */ } }
    if (typeof window !== 'undefined') { window.removeEventListener('online', this.wake); document.removeEventListener('visibilitychange', this.wake); }
  }

  reconnect() { if (this.started) { this.retry = 0; this.open(); } }

  private wake = () => { if (this.started && (!('hidden' in document) || !document.hidden)) this.open(); };

  on(event: string, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }
  off(event: string, fn: Listener) { this.listeners.get(event)?.delete(fn); }
  private fire(event: string, ...args: any[]) { this.listeners.get(event)?.forEach((fn) => fn(...args)); }

  emit(event: string, ...args: any[]) {
    const ack = typeof args[args.length - 1] === 'function' ? (args.pop() as (r: any) => void) : undefined;
    const payload = args[0] ?? {};
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = this.nextId++;
    if (ack) this.acks.set(id, ack);
    this.ws.send(JSON.stringify({ t: 'emit', id, event, payload }));
  }

  private open() {
    if (!this.started || (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'hello') {
        this.retry = 0;
        this.connected = true;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}'); }, 25_000);
        this.fire('connect');
      } else if (msg.t === 'ack') {
        const cb = this.acks.get(msg.id);
        this.acks.delete(msg.id);
        cb?.(msg.res);
      } else if (msg.t === 'event') {
        this.fire(msg.event, msg.payload);
      }
    };

    const down = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      this.acks.clear();
      if (this.connected) { this.connected = false; this.fire('disconnect'); }
      if (!this.started) return;
      const delay = Math.min(500 * 2 ** this.retry++, 4000);
      setTimeout(() => this.open(), delay);
    };
    ws.onclose = down;
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
}

export const socket = new GameSocket();

const TIMEOUT = 8000;
const offline = <T extends object>(): AckResult<T> => ({ ok: false, code: 'BAD_REQUEST', error: 'The server did not answer. Check your connection.' });

function withTimeout<T extends object>(run: (done: (r: AckResult<T>) => void) => void): Promise<AckResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(offline<T>()); } }, TIMEOUT);
    run((r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); });
  });
}

export const api = {
  create: () => withTimeout<SeatGrant>((done) => socket.emit('room:create', {}, done)),
  join: (roomId: string) => withTimeout<SeatGrant>((done) => socket.emit('room:join', { roomId }, done)),
  rejoin: (roomId: string, token: string) => withTimeout<SeatGrant>((done) => socket.emit('room:rejoin', { roomId, token }, done)),
  leave: () => withTimeout((done) => socket.emit('room:leave', done)),
  act: (action: GameAction) => withTimeout((done) => socket.emit('game:action', { action }, done)),
  continueGame: () => withTimeout((done) => socket.emit('game:continue', done)),
};
