/**
 * Shared domain types. Imported by the server (authoritative engine) and the
 * client (rendering + UI hints). Pure types only: no runtime code here.
 */
export type GoodType = 'diamond' | 'gold' | 'silver' | 'cloth' | 'spice' | 'leather';
export type CardType = GoodType | 'camel';
/** Seat number, 0..3 (seats are in clockwise turn order). */
export type PlayerIndex = 0 | 1 | 2 | 3;
/** Number of players in a game: 2 (classic), 3 (Trio) or 4 (Grand Bazaar). */
export type GameMode = 2 | 3 | 4;
export type BonusSize = 3 | 4 | 5;

export interface Card {
  id: string;
  type: CardType;
}

export interface GoodsToken {
  id: string;
  good: GoodType;
  value: number;
}

export interface BonusToken {
  id: string;
  size: BonusSize;
  value: number;
}

/** A bonus token whose value the viewer is not allowed to see. */
export interface HiddenBonusToken {
  id: string;
  size: BonusSize;
  value: null;
}

export type GameAction =
  | { type: 'takeGood'; cardId: string }
  | { type: 'takeCamels' }
  | { type: 'exchange'; takeIds: string[]; giveIds: string[]; giveCamels: number }
  | { type: 'sell'; cardIds: string[] };

export type GameActionType = GameAction['type'];
export type RoundEndReason = 'tokens' | 'deck';
/** Which criterion decided the Seal of Excellence. */
export type SealDecider = 'rupees' | 'bonusCount' | 'goodsCount' | 'unbroken';
export type GamePhase = 'playing' | 'roundOver' | 'gameOver';

export interface ScoreBreakdown {
  goods: number;
  bonus: number;
  camel: number;
  total: number;
  goodsTokenCount: number;
  bonusTokenCount: number;
  camels: number;
  goodsTokens: GoodsToken[];
  bonusTokens: BonusToken[];
}

export interface RoundResult {
  round: number;
  reason: RoundEndReason;
  /** One entry per seat. */
  scores: ScoreBreakdown[];
  camelWinner: PlayerIndex | null;
  sealWinner: PlayerIndex | null;
  decidedBy: SealDecider;
  /** Seals per seat after this round. */
  sealsAfter: number[];
}

export type LogBody =
  | { kind: 'roundStart'; round: number; starter: PlayerIndex }
  | { kind: 'takeGood'; player: PlayerIndex; good: GoodType }
  | { kind: 'takeCamels'; player: PlayerIndex; count: number }
  | { kind: 'exchange'; player: PlayerIndex; took: GoodType[]; gave: CardType[] }
  | { kind: 'sell'; player: PlayerIndex; good: GoodType; count: number; rupees: number; tokens: number; bonus: BonusSize | null }
  | { kind: 'roundEnd'; round: number; reason: RoundEndReason }
  | { kind: 'camelToken'; player: PlayerIndex | null }
  | { kind: 'seal'; player: PlayerIndex | null; decidedBy: SealDecider }
  | { kind: 'timeout'; player: PlayerIndex; missed: number }
  | { kind: 'forfeit'; loser: PlayerIndex }
  | { kind: 'gameEnd'; winner: PlayerIndex };

export type LogEntry = LogBody & { id: number };

export interface GameEvent {
  seq: number;
  player: PlayerIndex;
  type: GameActionType | 'roundStart' | 'timeout';
}

// ---------------------------------------------------------------------------
// Views: what a single player is allowed to see.
// ---------------------------------------------------------------------------

export interface PublicRoundView {
  number: number;
  deckCount: number;
  market: Card[];
  discardCount: number;
  discardTop: Card | null;
  /** Remaining goods tokens per type, top of the stack first (values are public). */
  goodsTokens: Record<GoodType, GoodsToken[]>;
  /** Remaining bonus token ids per size, top first. Values are hidden. */
  bonusStacks: Record<BonusSize, string[]>;
  camelTokenAvailable: boolean;
  currentPlayer: PlayerIndex;
  startingPlayer: PlayerIndex;
  depletedTypes: number;
}

export interface SelfView {
  hand: Card[];
  herd: Card[];
  goodsTokens: GoodsToken[];
  bonusTokens: BonusToken[];
}

/** Opponent camel count is not public in the official rules; only the herd's rough size is visible. */
export type HerdHint = 'none' | 'few' | 'herd' | 'caravan';

export interface OpponentView {
  seat: PlayerIndex;
  handCount: number;
  herdHint: HerdHint;
  goodsTokens: GoodsToken[];
  bonusTokens: HiddenBonusToken[];
}

export interface GameView {
  phase: GamePhase;
  mode: GameMode;
  handLimit: number;
  marketSize: number;
  /** Rounds after which a 3/4-player game is over (null = play until someone has 2 seals). */
  maxRounds: number | null;
  round: PublicRoundView;
  me: SelfView;
  /** The other players, in turn order starting after you. */
  opponents: OpponentView[];
  seals: number[];
  /** Seats that forfeited or left (they are skipped). */
  out: boolean[];
  results: RoundResult[];
  winner: PlayerIndex | null;
  /** Set when the game ended because this player missed too many turns / left. */
  forfeit: PlayerIndex | null;
  log: LogEntry[];
  lastEvent: GameEvent | null;
  version: number;
}

export type RoomStatus = 'waiting' | GamePhase;

export interface RoomPlayerView {
  name: string;
  connected: boolean;
  left: boolean;
}

/** Server-authoritative turn clock. Clients derive the remaining time from serverNow to avoid clock skew. */
export interface TurnTimerView {
  deadline: number;
  durationMs: number;
  serverNow: number;
}

export interface RoomView {
  roomId: string;
  you: PlayerIndex;
  mode: GameMode;
  /** One slot per seat; null = empty seat (only while waiting). */
  players: (RoomPlayerView | null)[];
  status: RoomStatus;
  /** "Continue" votes between rounds / for a rematch. */
  ready: boolean[];
  /** Consecutive missed turns per seat. */
  missed: number[];
  /** Present only while a round is being played. */
  turn: TurnTimerView | null;
  game: GameView | null;
}

// ---------------------------------------------------------------------------
// Chat & voice
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: number;
  seat: PlayerIndex;
  name: string;
  text: string;
  at: number;
}

/** WebRTC signalling payload relayed between two seats (opaque to the server). */
export type VoiceSignal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: Record<string, unknown> | null };
