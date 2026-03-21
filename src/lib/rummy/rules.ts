import { cardLabel, rankToSequenceValue } from "./cards";
import type { Card, HandScoreInput, JokerBinding, MeldAnalysis, TableMeld } from "./types";

export function scoreCard(card: Card): number {
  if (card.isJoker || card.rank === "A") {
    return 15;
  }

  if (card.rank === "J" || card.rank === "Q" || card.rank === "K") {
    return 10;
  }

  return Number(card.rank);
}

export function scoreCards(cards: Card[]): number {
  return cards.reduce((total, card) => total + scoreCard(card), 0);
}

export function scoreHand(input: HandScoreInput): number {
  return scoreCards(input.melded) + scoreCards(input.laidOff) - scoreCards(input.deadwood);
}

export function analyzeMeld(cards: Card[]): MeldAnalysis {
  if (cards.length < 3) {
    return invalidMeld("Melds require at least three cards.");
  }

  if (cards.every((card) => card.isJoker)) {
    return invalidMeld("At least one natural card is required to anchor a meld.");
  }

  const setResult = analyzeSet(cards);

  if (setResult.isValid) {
    return setResult;
  }

  const runResult = analyzeRun(cards);

  if (runResult.isValid) {
    return runResult;
  }

  return invalidMeld(`${setResult.reason} ${runResult.reason}`.trim());
}

export function analyzeLayoff(meld: TableMeld, card: Card): MeldAnalysis {
  if (!meld.type || !Array.isArray(meld.cards) || meld.cards.length < 3) {
    return invalidMeld("Target meld is invalid.");
  }

  const resolvedCards = resolveMeldCards(meld);
  const result = analyzeMeld([...resolvedCards, card]);

  if (!result.isValid || result.kind === "invalid") {
    return result;
  }

  if (result.kind !== meld.type) {
    return invalidMeld("Card does not fit the selected meld.");
  }

  return result;
}

function analyzeSet(cards: Card[]): MeldAnalysis {
  if (cards.length > 4) {
    return invalidMeld("Sets are limited to three or four cards in this implementation.");
  }

  const naturals = cards.filter((card) => !card.isJoker);

  if (naturals.length === 0) {
    return invalidMeld("Sets need at least one natural card.");
  }

  const targetRank = naturals[0].rank;
  const sameRank = naturals.every((card) => card.rank === targetRank);

  if (!sameRank) {
    return invalidMeld("Natural cards in a set must share the same rank.");
  }

  const suitSet = new Set(naturals.map((card) => card.suit));

  if (suitSet.size !== naturals.length) {
    return invalidMeld("Sets cannot repeat the same suit.");
  }

  const jokerCards = cards.filter((card) => card.isJoker);
  const missingSuits = (["clubs", "diamonds", "hearts", "spades"] as const).filter((suit) => !suitSet.has(suit));

  if (jokerCards.length > missingSuits.length) {
    return invalidMeld("Not enough distinct suits remain to place jokers in this set.");
  }

  const jokerBindings: JokerBinding[] = jokerCards.map((jokerCard, index) => ({
    joker_id: jokerCard.id,
    rank: targetRank as Exclude<typeof targetRank, "JOKER">,
    suit: missingSuits[index]
  }));

  return {
    kind: "set",
    isValid: true,
    points: scoreCards(cards),
    jokerBindings
  };
}

function analyzeRun(cards: Card[]): MeldAnalysis {
  const naturals = cards.filter((card) => !card.isJoker);
  const jokerCards = cards.filter((card) => card.isJoker);

  if (naturals.length === 0) {
    return invalidMeld("Runs need at least one natural card.");
  }

  const suit = naturals[0].suit;
  const sameSuit = naturals.every((card) => card.suit === suit);

  if (!sameSuit) {
    return invalidMeld("Natural cards in a run must share the same suit.");
  }

  const lowResolution = resolveRunJokers(naturals, jokerCards, "low");
  const highResolution = resolveRunJokers(naturals, jokerCards, "high");

  if (!lowResolution && !highResolution) {
    return invalidMeld(
      `Cards do not form a valid run: ${cards.map((card) => cardLabel(card)).join(", ")}`
    );
  }

  const resolution =
    highResolution && lowResolution
      ? highResolution.values.at(-1)! >= lowResolution.values.at(-1)!
        ? highResolution
        : lowResolution
      : highResolution ?? lowResolution;

  return {
    kind: "run",
    isValid: true,
    points: scoreCards(cards),
    jokerBindings: resolution?.jokerBindings ?? []
  };
}

function resolveRunJokers(cards: Card[], jokerCards: Card[], aceMode: "low" | "high") {
  const values = cards.map((card) => rankToSequenceValue(card.rank, aceMode)).sort((left, right) => left - right);
  const duplicates = new Set(values);

  if (duplicates.size !== values.length) {
    return null;
  }

  const missingValues: number[] = [];

  for (let index = 1; index < values.length; index += 1) {
    for (let value = values[index - 1] + 1; value < values[index]; value += 1) {
      missingValues.push(value);
    }
  }

  if (missingValues.length > jokerCards.length) {
    return null;
  }

  const limitHigh = aceMode === "high" ? 14 : 13;
  const limitLow = aceMode === "low" ? 1 : 2;
  let nextHigh = values[values.length - 1] + 1;
  let nextLow = values[0] - 1;
  let remainingJokers = jokerCards.length - missingValues.length;
  const extensionValues: number[] = [];

  while (remainingJokers > 0 && nextHigh <= limitHigh) {
    extensionValues.push(nextHigh);
    nextHigh += 1;
    remainingJokers -= 1;
  }

  while (remainingJokers > 0 && nextLow >= limitLow) {
    extensionValues.push(nextLow);
    nextLow -= 1;
    remainingJokers -= 1;
  }

  if (remainingJokers > 0) {
    return null;
  }

  const representedValues = [...missingValues, ...extensionValues].sort((left, right) => left - right);
  const suit = cards[0].suit;

  if (!suit) {
    return null;
  }

  return {
    values: [...values, ...representedValues].sort((left, right) => left - right),
    jokerBindings: jokerCards.map((jokerCard, index) => ({
      joker_id: jokerCard.id,
      rank: sequenceValueToRank(representedValues[index], aceMode),
      suit
    }))
  };
}

function invalidMeld(reason: string): MeldAnalysis {
  return {
    kind: "invalid",
    isValid: false,
    points: 0,
    reason
  };
}

function resolveMeldCards(meld: TableMeld): Card[] {
  const cards = Array.isArray(meld.cards) ? meld.cards : [];
  const bindings = new Map((meld.joker_bindings ?? []).map((binding) => [binding.joker_id, binding]));

  return cards.map((card) => {
    if (!card.isJoker) {
      return card;
    }

    const binding = bindings.get(card.id);

    if (!binding) {
      return card;
    }

    return {
      ...card,
      rank: binding.rank,
      suit: binding.suit,
      isJoker: false
    };
  });
}

function sequenceValueToRank(value: number, aceMode: "low" | "high"): Exclude<Card["rank"], "JOKER"> {
  if (value === 14 && aceMode === "high") {
    return "A";
  }

  if (value === 1) {
    return "A";
  }

  if (value === 11) {
    return "J";
  }

  if (value === 12) {
    return "Q";
  }

  if (value === 13) {
    return "K";
  }

  return String(value) as Exclude<Card["rank"], "JOKER">;
}
