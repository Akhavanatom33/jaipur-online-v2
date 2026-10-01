import type { BonusSize, CardType, GameMode, GoodType } from './types.ts';

/**
 * Official Jaipur component data (Space Cowboys rulebook, 2025 edition):
 * 55 cards, 38 goods tokens, 18 bonus tokens, 1 camel token, 3 Seals of Excellence.
 * These are the 2-player numbers. The 3 and 4 player modes (see MODES below) use a
 * bigger deck, a bigger market and longer token stacks.
 */
export const GOODS: readonly GoodType[] = ['diamond', 'gold', 'silver', 'cloth', 'spice', 'leather'];
export const PRECIOUS_GOODS: readonly GoodType[] = ['diamond', 'gold', 'silver'];
export const CARD_TYPES: readonly CardType[] = [...GOODS, 'camel'];

export const CARD_COUNTS: Readonly<Record<CardType, number>> = {
  diamond: 6,
  gold: 6,
  silver: 6,
  cloth: 8,
  spice: 8,
  leather: 10,
  camel: 11,
};

/** Goods token values, top of the stack first (stacks are sorted in descending order). */
export const GOODS_TOKEN_VALUES: Readonly<Record<GoodType, readonly number[]>> = {
  diamond: [7, 7, 5, 5, 5],
  gold: [6, 6, 5, 5, 5],
  silver: [5, 5, 5, 5, 5],
  cloth: [5, 3, 3, 2, 2, 1, 1],
  spice: [5, 3, 3, 2, 2, 1, 1],
  leather: [4, 3, 2, 1, 1, 1, 1, 1, 1],
};

export const BONUS_SIZES: readonly BonusSize[] = [3, 4, 5];

/** Bonus token values per stack; each stack is shuffled separately and kept face down. */
export const BONUS_TOKEN_VALUES: Readonly<Record<BonusSize, readonly number[]>> = {
  3: [3, 3, 2, 2, 2, 1, 1],
  4: [6, 6, 5, 5, 4, 4],
  5: [10, 10, 9, 8, 8],
};

export const BONUS_RANGES: Readonly<Record<BonusSize, string>> = { 3: '1-3', 4: '4-6', 5: '8-10' };

export const HAND_LIMIT = 7;
export const HAND_SIZE = 5;
export const MARKET_SIZE = 5;
export const INITIAL_MARKET_CAMELS = 3;
export const CAMEL_TOKEN_VALUE = 5;
export const MIN_PRECIOUS_SALE = 2;
export const MIN_EXCHANGE = 2;
export const DEPLETED_TYPES_TO_END = 3;
export const SEALS_TO_WIN = 2;
export const TOTAL_SEALS = 3;
/** Biggest market of any mode; used to bound client input. */
export const MAX_MARKET_SIZE = 7;
/** Games with 3 or 4 players end after this many rounds at the latest. */
export const MULTI_MAX_ROUNDS = 3;

export function isPrecious(good: CardType): boolean {
  return (PRECIOUS_GOODS as readonly string[]).includes(good);
}

export const CARD_LABELS: Readonly<Record<CardType, { one: string; many: string }>> = {
  diamond: { one: 'Diamond', many: 'Diamonds' },
  gold: { one: 'Gold', many: 'Gold' },
  silver: { one: 'Silver', many: 'Silver' },
  cloth: { one: 'Cloth', many: 'Cloth' },
  spice: { one: 'Spice', many: 'Spices' },
  leather: { one: 'Leather', many: 'Leather' },
  camel: { one: 'Camel', many: 'Camels' },
};

export function cardLabel(type: CardType, count = 1): string {
  return count === 1 ? CARD_LABELS[type].one : CARD_LABELS[type].many;
}

/** Turn timer: a player who lets the clock run out loses that turn. (20 seconds, as requested.) */
export const TURN_SECONDS = 20;
/** Consecutive missed turns after which a player forfeits the game. */
export const MAX_MISSED_TURNS = 3;

// ---------------------------------------------------------------------------
// Game modes
// ---------------------------------------------------------------------------

export interface ModeConfig {
  players: GameMode;
  title: string;
  tagline: string;
  handLimit: number;
  handSize: number;
  marketSize: number;
  initialMarketCamels: number;
  cardCounts: Readonly<Record<CardType, number>>;
  goodsTokens: Readonly<Record<GoodType, readonly number[]>>;
  bonusTokens: Readonly<Record<BonusSize, readonly number[]>>;
  /** Coins paid to the winner of a finished game. */
  winCoins: number;
}

const sumCounts = (c: Record<CardType, number>) => Object.values(c).reduce((a, b) => a + b, 0);

export const MODES: Readonly<Record<GameMode, ModeConfig>> = {
  2: {
    players: 2,
    title: 'Duel',
    tagline: 'The classic head-to-head. 55 cards.',
    handLimit: HAND_LIMIT,
    handSize: HAND_SIZE,
    marketSize: MARKET_SIZE,
    initialMarketCamels: INITIAL_MARKET_CAMELS,
    cardCounts: CARD_COUNTS,
    goodsTokens: GOODS_TOKEN_VALUES,
    bonusTokens: BONUS_TOKEN_VALUES,
    winCoins: 50,
  },
  3: {
    players: 3,
    title: 'Trio',
    tagline: 'Three traders, a bigger bazaar. 70 cards.',
    handLimit: 8,
    handSize: HAND_SIZE,
    marketSize: 6,
    initialMarketCamels: 3,
    cardCounts: { diamond: 8, gold: 8, silver: 8, cloth: 10, spice: 10, leather: 12, camel: 14 },
    goodsTokens: {
      diamond: [7, 7, 6, 5, 5, 5, 4],
      gold: [6, 6, 6, 5, 5, 5, 4],
      silver: [5, 5, 5, 5, 5, 4, 4],
      cloth: [5, 4, 3, 3, 2, 2, 1, 1, 1],
      spice: [5, 4, 3, 3, 2, 2, 1, 1, 1],
      leather: [4, 3, 3, 2, 1, 1, 1, 1, 1, 1, 1],
    },
    bonusTokens: {
      3: [3, 3, 3, 2, 2, 2, 1, 1, 1],
      4: [6, 6, 5, 5, 5, 4, 4],
      5: [10, 10, 9, 9, 8, 8],
    },
    winCoins: 75,
  },
  4: {
    players: 4,
    title: 'Grand Bazaar',
    tagline: 'Four rivals, a huge market. 85 cards.',
    handLimit: 9,
    handSize: HAND_SIZE,
    marketSize: 7,
    initialMarketCamels: 4,
    cardCounts: { diamond: 10, gold: 10, silver: 10, cloth: 12, spice: 12, leather: 14, camel: 17 },
    goodsTokens: {
      diamond: [7, 7, 7, 6, 5, 5, 5, 4, 4],
      gold: [6, 6, 6, 6, 5, 5, 5, 4, 4],
      silver: [5, 5, 5, 5, 5, 5, 4, 4, 4],
      cloth: [5, 4, 3, 3, 3, 2, 2, 1, 1, 1, 1],
      spice: [5, 4, 3, 3, 3, 2, 2, 1, 1, 1, 1],
      leather: [4, 3, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1],
    },
    bonusTokens: {
      3: [3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1],
      4: [6, 6, 6, 5, 5, 5, 4, 4, 4],
      5: [10, 10, 10, 9, 9, 8, 8, 8],
    },
    winCoins: 100,
  },
};

export const GAME_MODES: readonly GameMode[] = [2, 3, 4];
export const LOSS_COINS = 10;

export const modeConfig = (mode: GameMode): ModeConfig => MODES[mode];
export const deckSize = (mode: GameMode): number => sumCounts({ ...MODES[mode].cardCounts });

export function parseMode(raw: unknown): GameMode {
  const n = Number(raw);
  return n === 3 || n === 4 ? n : 2;
}
