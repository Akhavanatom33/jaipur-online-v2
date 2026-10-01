import type {
  BonusSize, BonusToken, Card, GameEvent, GameMode, GamePhase, GoodType, GoodsToken, LogEntry,
  PlayerIndex, RoundEndReason, RoundResult,
} from '../../shared/types.ts';

/** Full, secret server-side state. Never sent to clients as-is (see view.ts). */
export interface PlayerState {
  hand: Card[];
  herd: Card[];
  goodsTokens: GoodsToken[];
  bonusTokens: BonusToken[];
}

export interface RoundState {
  number: number;
  deck: Card[];
  market: Card[];
  discard: Card[];
  goodsTokens: Record<GoodType, GoodsToken[]>;
  bonusStacks: Record<BonusSize, BonusToken[]>;
  camelTokenAvailable: boolean;
  /** One entry per seat (2, 3 or 4). */
  players: PlayerState[];
  currentPlayer: PlayerIndex;
  startingPlayer: PlayerIndex;
  endReason: RoundEndReason | null;
}

/** Plain JSON-serialisable object, so it can be moved to Redis or another store later. */
export interface GameState {
  phase: GamePhase;
  /** Number of seats. Optional so games saved by older versions (always 2 players) still load. */
  mode?: GameMode;
  round: RoundState;
  seals: number[];
  results: RoundResult[];
  winner: PlayerIndex | null;
  /** Player who lost by missing too many turns / leaving (optional so older saved rooms still load). */
  forfeit?: PlayerIndex | null;
  /** Seats that forfeited or left. They are skipped in turn order. */
  out?: boolean[];
  log: LogEntry[];
  nextLogId: number;
  lastEvent: GameEvent | null;
  version: number;
}

export const playerCount = (state: { round: RoundState }): number => state.round.players.length;
export const modeOf = (state: GameState): GameMode => (state.mode ?? (state.round.players.length as GameMode));
export const isOut = (state: GameState, seat: number): boolean => Boolean(state.out?.[seat]);

/** The seat that plays after `p`, clockwise, skipping seats that forfeited. */
export function nextSeat(state: GameState, p: PlayerIndex): PlayerIndex {
  const n = state.round.players.length;
  for (let i = 1; i <= n; i++) {
    const s = ((p + i) % n) as PlayerIndex;
    if (!isOut(state, s)) return s;
  }
  return p;
}

/** Two-player helper kept for older callers. */
export const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);
