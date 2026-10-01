/** Projects secret server state into what ONE player may see. */
import type { BonusSize, GameView, GoodType, HerdHint, OpponentView, PlayerIndex } from '../../shared/types.ts';
import { BONUS_SIZES, GOODS, modeConfig } from '../../shared/constants.ts';
import { depletedTypes, maxRoundsFor } from './engine.ts';
import { modeOf, type GameState } from './state.ts';

export function herdHint(n: number): HerdHint {
  if (n === 0) return 'none';
  if (n <= 3) return 'few';
  if (n <= 6) return 'herd';
  return 'caravan';
}

export function toGameView(state: GameState, viewer: PlayerIndex): GameView {
  const r = state.round;
  const mode = modeOf(state);
  const cfg = modeConfig(mode);
  const me = r.players[viewer];
  const goodsTokens = {} as Record<GoodType, GameView['round']['goodsTokens'][GoodType]>;
  for (const g of GOODS) goodsTokens[g] = r.goodsTokens[g].map((t) => ({ ...t }));
  const bonusStacks = {} as Record<BonusSize, string[]>;
  for (const s of BONUS_SIZES) bonusStacks[s] = r.bonusStacks[s].map((t) => t.id);

  // Opponents in clockwise order, starting with the player who moves after the viewer.
  const opponents: OpponentView[] = [];
  for (let i = 1; i < r.players.length; i++) {
    const seat = ((viewer + i) % r.players.length) as PlayerIndex;
    const opp = r.players[seat];
    opponents.push({
      seat,
      handCount: opp.hand.length,
      herdHint: herdHint(opp.herd.length),
      goodsTokens: opp.goodsTokens.map((t) => ({ ...t })),
      bonusTokens: opp.bonusTokens.map((t) => ({ id: t.id, size: t.size, value: null })),
    });
  }

  return {
    phase: state.phase,
    mode,
    handLimit: cfg.handLimit,
    marketSize: cfg.marketSize,
    maxRounds: maxRoundsFor(mode),
    round: {
      number: r.number,
      deckCount: r.deck.length,
      market: r.market.map((c) => ({ ...c })),
      discardCount: r.discard.length,
      discardTop: r.discard.length ? { ...r.discard[r.discard.length - 1] } : null,
      goodsTokens,
      bonusStacks,
      camelTokenAvailable: r.camelTokenAvailable,
      currentPlayer: r.currentPlayer,
      startingPlayer: r.startingPlayer,
      depletedTypes: depletedTypes(r),
    },
    me: {
      hand: me.hand.map((c) => ({ ...c })),
      herd: me.herd.map((c) => ({ ...c })),
      goodsTokens: me.goodsTokens.map((t) => ({ ...t })),
      bonusTokens: me.bonusTokens.map((t) => ({ ...t })),
    },
    opponents,
    seals: state.seals.slice(),
    out: r.players.map((_, i) => Boolean(state.out?.[i])),
    // Results are revealed in full once a round has ended.
    results: structuredClone(state.results),
    winner: state.winner,
    forfeit: state.forfeit ?? null,
    log: state.log.slice(-120).map((e) => ({ ...e })),
    lastEvent: state.lastEvent ? { ...state.lastEvent } : null,
    version: state.version,
  };
}
