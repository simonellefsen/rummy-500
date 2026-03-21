import type { GameConfig } from "./types";

export function createGameConfig(playerCount = 4): GameConfig {
  const useTwoDecks = playerCount >= 5;

  return {
    playerCount,
    decks: useTwoDecks ? 2 : 1,
    jokers: useTwoDecks ? 4 : 2,
    cardsPerPlayer: playerCount === 2 ? 13 : 7,
    maxPlayers: 8,
    variants: {
      aceCanBeLow: true,
      aceCanBeHigh: true,
      minimumInitialMeldPoints: 0,
      mustDiscardToGoOut: true,
      visibleDiscardPile: false
    }
  };
}
