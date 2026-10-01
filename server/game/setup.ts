import type { BonusSize, BonusToken, Card, CardType, GameMode, GoodType, GoodsToken, PlayerIndex } from '../../shared/types.ts';
import { BONUS_SIZES, CARD_TYPES, GOODS, modeConfig } from '../../shared/constants.ts';
import { shuffle, type Rng } from './rng.ts';
import type { PlayerState, RoundState } from './state.ts';

const emptyPlayer = (): PlayerState => ({ hand: [], herd: [], goodsTokens: [], bonusTokens: [] });

/**
 * Official setup (scaled for 3 and 4 players, see MODES in shared/constants.ts):
 * 1. Camels face up in the market. 2. Shuffle the other cards.
 * 3. Deal 5 to each player. 4. Fill the market up to its size.
 * 5. Players move camels from hand to herd. 6. Goods tokens sorted descending,
 *    bonus tokens shuffled per stack, camel token beside them.
 */
export function createRound(number: number, startingPlayer: PlayerIndex, rng: Rng, mode: GameMode = 2): RoundState {
  const cfg = modeConfig(mode);
  let seq = 0;
  // Ids are assigned after shuffling and are opaque: they never encode card type or position.
  const mk = (type: CardType): Card => ({ id: `r${number}c${(seq++).toString(36)}`, type });

  const market: Card[] = [];
  for (let i = 0; i < cfg.initialMarketCamels; i++) market.push(mk('camel'));

  const rest: CardType[] = [];
  for (const type of CARD_TYPES) {
    const n = cfg.cardCounts[type] - (type === 'camel' ? cfg.initialMarketCamels : 0);
    for (let i = 0; i < n; i++) rest.push(type);
  }
  const deck = shuffle(rest, rng).map(mk);

  const players: PlayerState[] = Array.from({ length: mode }, emptyPlayer);
  for (let i = 0; i < cfg.handSize; i++) {
    for (const p of players) p.hand.push(deck.shift()!);
  }
  while (market.length < cfg.marketSize) market.push(deck.shift()!);

  for (const p of players) {
    p.herd = p.hand.filter((c) => c.type === 'camel');
    p.hand = p.hand.filter((c) => c.type !== 'camel');
  }

  const goodsTokens = {} as Record<GoodType, GoodsToken[]>;
  for (const good of GOODS) {
    goodsTokens[good] = cfg.goodsTokens[good].map((value, i) => ({ id: `r${number}t${good}${i}`, good, value }));
  }

  const bonusStacks = {} as Record<BonusSize, BonusToken[]>;
  for (const size of BONUS_SIZES) {
    bonusStacks[size] = shuffle(cfg.bonusTokens[size], rng).map((value, i) => ({ id: `r${number}b${size}n${i}`, size, value }));
  }

  return {
    number,
    deck,
    market,
    discard: [],
    goodsTokens,
    bonusStacks,
    camelTokenAvailable: true,
    players,
    currentPlayer: startingPlayer,
    startingPlayer,
    endReason: null,
  };
}
