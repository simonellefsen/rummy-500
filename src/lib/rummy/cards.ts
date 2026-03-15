import type { Card, DealResult, GameConfig, PlayerId, Rank, Suit } from "./types";
import { RANKS, SUITS } from "./types";

const SUIT_SYMBOLS: Record<Suit, string> = {
  clubs: "C",
  diamonds: "D",
  hearts: "H",
  spades: "S"
};

export function createDeck(config: Pick<GameConfig, "decks" | "jokers">): Card[] {
  const cards: Card[] = [];

  for (let deck = 1; deck <= config.decks; deck += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({
          id: `${deck}-${suit}-${rank}`,
          deck,
          rank,
          suit,
          isJoker: false
        });
      }
    }
  }

  for (let jokerIndex = 0; jokerIndex < config.jokers; jokerIndex += 1) {
    const deck = (jokerIndex % config.decks) + 1;

    cards.push({
      id: `${deck}-joker-${jokerIndex + 1}`,
      deck,
      rank: "JOKER",
      suit: null,
      isJoker: true
    });
  }

  return cards;
}

export function shuffleCards(cards: Card[], random = Math.random): Card[] {
  const nextCards = [...cards];

  for (let index = nextCards.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = nextCards[index];

    nextCards[index] = nextCards[swapIndex];
    nextCards[swapIndex] = current;
  }

  return nextCards;
}

export function dealOpeningHands(
  deck: Card[],
  playerIds: PlayerId[],
  cardsPerPlayer: number
): DealResult {
  const requiredCards = playerIds.length * cardsPerPlayer + 1;

  if (deck.length < requiredCards) {
    throw new Error(`Deck is too small to deal ${playerIds.length} hands.`);
  }

  const hands = Object.fromEntries(playerIds.map((playerId) => [playerId, [] as Card[]]));
  const drawPile = [...deck];

  for (let round = 0; round < cardsPerPlayer; round += 1) {
    for (const playerId of playerIds) {
      const card = drawPile.shift();

      if (!card) {
        throw new Error("Deck ran out while dealing.");
      }

      hands[playerId].push(card);
    }
  }

  const firstDiscard = drawPile.shift();

  if (!firstDiscard) {
    throw new Error("Deck ran out before the opening discard could be created.");
  }

  return {
    hands,
    discardPile: [firstDiscard],
    stock: drawPile
  };
}

export function rankToSequenceValue(rank: Rank, aceMode: "low" | "high" = "high"): number {
  if (rank === "JOKER") {
    throw new Error("Jokers do not have a fixed sequence value.");
  }

  if (rank === "A") {
    return aceMode === "low" ? 1 : 14;
  }

  if (rank === "J") {
    return 11;
  }

  if (rank === "Q") {
    return 12;
  }

  if (rank === "K") {
    return 13;
  }

  return Number(rank);
}

export function cardLabel(card: Card): string {
  if (card.isJoker) {
    return "JOKER";
  }

  return `${card.rank}${SUIT_SYMBOLS[card.suit!]}`;
}
