import type { ChatMessage, GameMode, PlayerIndex } from '../../shared/types.ts';
import type { GameState } from '../game/state.ts';

export interface RoomPlayer {
  /** Secret seat token; lets the same authenticated player reclaim the seat after a disconnect. */
  token: string;
  userId: string;
  name: string;
  socketId: string | null;
  connected: boolean;
  left: boolean;
  lastSeen: number;
}

export interface Room {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** 2, 3 or 4 seats. Optional so rooms saved by older versions (always 2 seats) still load. */
  mode?: GameMode;
  /** One slot per seat; null = empty seat while the room is waiting for players. */
  players: (RoomPlayer | null)[];
  game: GameState | null;
  ready: boolean[];
  gameRecordId: string | null;
  /** Epoch ms when the current player's turn expires (null = no clock running). */
  turnDeadline?: number | null;
  /** Consecutive missed turns per seat. */
  missed?: number[];
  /** Last chat messages (kept with the room so a reconnecting player sees them). */
  chat?: ChatMessage[];
  chatSeq?: number;
}

export type Seat = PlayerIndex;
