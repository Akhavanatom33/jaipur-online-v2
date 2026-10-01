import type { PlayerIndex } from '../../shared/types.ts';
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
  players: [RoomPlayer | null, RoomPlayer | null];
  game: GameState | null;
  ready: [boolean, boolean];
  gameRecordId: string | null;
  /** Epoch ms when the current player's turn expires (null = no clock running). */
  turnDeadline?: number | null;
  /** Consecutive missed turns per seat. */
  missed?: [number, number];
}

export type Seat = PlayerIndex;
