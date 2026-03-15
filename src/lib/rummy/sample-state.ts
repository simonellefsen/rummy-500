import { createGameConfig } from "./config";
import { cardLabel, createDeck, dealOpeningHands, shuffleCards } from "./cards";
import { analyzeMeld } from "./rules";

function createSeededRandom(seed: number): () => number {
  let value = seed % 2147483647;

  if (value <= 0) {
    value += 2147483646;
  }

  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

export function buildSampleGameState() {
  const config = createGameConfig(4);
  const players = ["North", "East", "South", "West"];
  const random = createSeededRandom(500);
  const openingDeal = dealOpeningHands(
    shuffleCards(createDeck(config), random),
    players,
    config.cardsPerPlayer
  );

  const exampleSet = analyzeMeld([
    { id: "1-hearts-7", deck: 1, rank: "7", suit: "hearts", isJoker: false },
    { id: "1-clubs-7", deck: 1, rank: "7", suit: "clubs", isJoker: false },
    { id: "1-diamonds-7", deck: 1, rank: "7", suit: "diamonds", isJoker: false }
  ]);

  const exampleRun = analyzeMeld([
    { id: "1-hearts-Q", deck: 1, rank: "Q", suit: "hearts", isJoker: false },
    { id: "1-hearts-K", deck: 1, rank: "K", suit: "hearts", isJoker: false },
    { id: "1-joker-1", deck: 1, rank: "JOKER", suit: null, isJoker: true }
  ]);

  return {
    config,
    players,
    hands: Object.fromEntries(
      players.map((player) => [
        player,
        openingDeal.hands[player].map((card) => cardLabel(card))
      ])
    ),
    discardTop: cardLabel(openingDeal.discardPile.at(-1)!),
    stockCount: openingDeal.stock.length,
    examples: {
      set: exampleSet,
      run: exampleRun
    }
  };
}
