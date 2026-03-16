import { analyzeMeld } from "./rules";
import type { Card } from "./types";

export interface SuggestedMeld {
  kind: "set" | "run";
  cards: Card[];
  points: number;
}

export function findSuggestedMelds(hand: Card[], selectedCardId: string): SuggestedMeld[] {
  const selectedCard = hand.find((card) => card.id === selectedCardId);

  if (!selectedCard) {
    return [];
  }

  const otherCards = hand.filter((card) => card.id !== selectedCardId);
  const suggestions = new Map<"set" | "run", SuggestedMeld>();

  for (const comboSize of [2, 3]) {
    for (const combo of buildCombinations(otherCards, comboSize)) {
      const candidate = [selectedCard, ...combo];
      const result = analyzeMeld(candidate);

      if (!result.isValid || result.kind === "invalid" || suggestions.has(result.kind)) {
        continue;
      }

      suggestions.set(result.kind, {
        kind: result.kind,
        cards: candidate,
        points: result.points
      });
    }
  }

  return [...suggestions.values()];
}

function buildCombinations(cards: Card[], size: number, start = 0, prefix: Card[] = []): Card[][] {
  if (size === 0) {
    return [prefix];
  }

  const combinations: Card[][] = [];

  for (let index = start; index <= cards.length - size; index += 1) {
    combinations.push(...buildCombinations(cards, size - 1, index + 1, [...prefix, cards[index]]));
  }

  return combinations;
}
