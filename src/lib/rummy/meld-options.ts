import { analyzeMeld } from "./rules";
import type { Card, TableMeld } from "./types";

export interface SuggestedMeld {
  kind: "set" | "run";
  cards: Card[];
  points: number;
}

export interface SuggestedLayoff {
  meldIndex: number;
  kind: "set" | "run";
  card: Card;
  targetCards: Card[];
  points: number;
}

export type SuggestedDiscardPickupUse =
  | {
      type: "meld";
      kind: "set" | "run";
      cardIds: string[];
    }
  | {
      type: "layoff";
      kind: "set" | "run";
      meldIndex: number;
    };

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

export function findSuggestedLayoffs(tableMelds: TableMeld[], selectedCard: Card): SuggestedLayoff[] {
  const suggestions: SuggestedLayoff[] = [];

  for (const [meldIndex, meld] of tableMelds.entries()) {
    if (!meld.type || !Array.isArray(meld.cards) || meld.cards.length < 3) {
      continue;
    }

    const targetCards = [...meld.cards, selectedCard];
    const result = analyzeMeld(targetCards);

    if (!result.isValid || result.kind === "invalid" || result.kind !== meld.type) {
      continue;
    }

    suggestions.push({
      meldIndex,
      kind: meld.type,
      card: selectedCard,
      targetCards,
      points: result.points
    });
  }

  return suggestions;
}

export function findDiscardPickupUses(hand: Card[], tableMelds: TableMeld[], requiredCardId: string): SuggestedDiscardPickupUse[] {
  const requiredCard = hand.find((card) => card.id === requiredCardId);

  if (!requiredCard) {
    return [];
  }

  const suggestions: SuggestedDiscardPickupUse[] = [];
  const otherCards = hand.filter((card) => card.id !== requiredCardId);
  const seenMelds = new Set<string>();

  for (const comboSize of [2, 3]) {
    for (const combo of buildCombinations(otherCards, comboSize)) {
      const candidate = [requiredCard, ...combo];
      const result = analyzeMeld(candidate);

      if (!result.isValid || result.kind === "invalid") {
        continue;
      }

      const suggestionKey = `${result.kind}:${candidate
        .map((card) => card.id)
        .sort()
        .join(",")}`;

      if (seenMelds.has(suggestionKey)) {
        continue;
      }

      seenMelds.add(suggestionKey);
      suggestions.push({
        type: "meld",
        kind: result.kind,
        cardIds: candidate.map((card) => card.id)
      });
    }
  }

  for (const [meldIndex, meld] of tableMelds.entries()) {
    if (!meld.type || !Array.isArray(meld.cards) || meld.cards.length < 3) {
      continue;
    }

    const result = analyzeMeld([...meld.cards, requiredCard]);

    if (!result.isValid || result.kind === "invalid" || result.kind !== meld.type) {
      continue;
    }

    suggestions.push({
      type: "layoff",
      kind: meld.type,
      meldIndex
    });
  }

  return suggestions;
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
