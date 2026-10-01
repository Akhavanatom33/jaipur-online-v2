import type { ChatMessage, GameAction, GameMode, PlayerIndex, RoomView, VoiceSignal } from './types.ts';

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'INVALID_CODE'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ALREADY_IN_ROOM'
  | 'SESSION_EXPIRED'
  | 'NOT_IN_ROOM'
  | 'GAME_NOT_STARTED'
  | 'ILLEGAL_ACTION'
  | 'RATE_LIMITED';

export type AckResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string; code: ErrorCode };
export type Ack<T extends object = object> = (res: AckResult<T>) => void;

export interface SeatGrant {
  roomId: string;
  token: string;
  you: PlayerIndex;
}

export interface ClientToServerEvents {
  'room:create': (payload: { mode?: GameMode }, ack: Ack<SeatGrant>) => void;
  'room:join': (payload: { roomId: string }, ack: Ack<SeatGrant>) => void;
  'room:rejoin': (payload: { roomId: string; token: string }, ack: Ack<SeatGrant>) => void;
  'room:leave': (ack: Ack) => void;
  'game:action': (payload: { action: GameAction }, ack: Ack) => void;
  'game:continue': (ack: Ack) => void;
  'chat:send': (payload: { text: string }, ack: Ack) => void;
  'voice:join': (payload: Record<string, never>, ack: Ack) => void;
  'voice:leave': (payload: Record<string, never>, ack: Ack) => void;
  'voice:signal': (payload: { to: number; data: VoiceSignal }, ack: Ack) => void;
}

export interface ServerToClientEvents {
  'room:state': (view: RoomView) => void;
  'chat:message': (msg: ChatMessage) => void;
  'chat:history': (msgs: ChatMessage[]) => void;
  /** Seats that are currently in the voice channel of your room. */
  'voice:peers': (payload: { seats: number[] }) => void;
  'voice:signal': (payload: { from: number; data: VoiceSignal }) => void;
}

export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CHAT_MAX_LENGTH = 300;

export function normalizeRoomCode(input: string): string {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isRoomCodeFormat(code: string): boolean {
  return code.length === ROOM_CODE_LENGTH && [...code].every((ch) => ROOM_CODE_ALPHABET.includes(ch));
}
