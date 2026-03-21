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

  const jokerBindingOptions = getSetBindingOptions(cards);

  if (jokerBindingOptions.length === 0) {
    return invalidMeld("Not enough distinct suits remain to place jokers in this set.");
  }

  return {
    kind: "set",
    isValid: true,
    points: scoreCards(cards),
    jokerBindings: jokerBindingOptions[0] ?? []
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

  const jokerBindingOptions = getRunBindingOptions(cards);

  if (jokerBindingOptions.length === 0) {
    return invalidMeld(
      `Cards do not form a valid run: ${cards.map((card) => cardLabel(card)).join(", ")}`
    );
  }

  return {
    kind: "run",
    isValid: true,
    points: scoreCards(cards),
    jokerBindings: jokerBindingOptions[0] ?? []
  };
}

export function getMeldBindingOptions(cards: Card[], kind: "set" | "run"): JokerBinding[][] {
  if (!cards.some((card) => card.isJoker)) {
    return [[]];
  }

  return kind === "set" ? getSetBindingOptions(cards) : getRunBindingOptions(cards);
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

function getSetBindingOptions(cards: Card[]): JokerBinding[][] {
  const naturals = cards.filter((card) => !card.isJoker);
  const jokerCards = cards.filter((card) => card.isJoker);

  if (jokerCards.length === 0) {
    return [[]];
  }

  const targetRank = naturals[0]?.rank;

  if (!targetRank) {
    return [];
  }

  const suitSet = new Set(naturals.map((card) => card.suit));
  const missingSuits = (["clubs", "diamonds", "hearts", "spades"] as const).filter((suit) => !suitSet.has(suit));

  if (jokerCards.length > missingSuits.length) {
    return [];
  }

  return permuteSuits(missingSuits, jokerCards.length).map((suits) =>
    jokerCards.map((jokerCard, index) => ({
      joker_id: jokerCard.id,
      rank: targetRank as Exclude<Card["rank"], "JOKER">,
      suit: suits[index]
    }))
  );
}

function getRunBindingOptions(cards: Card[]): JokerBinding[][] {
  const naturals = cards.filter((card) => !card.isJoker);
  const jokerCards = cards.filter((card) => card.isJoker);

  const lowResolutions = enumerateRunResolutions(naturals, jokerCards, "low");
  const highResolutions = enumerateRunResolutions(naturals, jokerCards, "high");
  const byKey = new Map<string, { values: number[]; jokerBindings: JokerBinding[] }>();

  for (const resolution of [...lowResolutions, ...highResolutions]) {
    const key = resolution.jokerBindings
      .map((binding) => `${binding.joker_id}:${binding.rank}:${binding.suit}`)
      .sort()
      .join("|");

    if (!byKey.has(key)) {
      byKey.set(key, resolution);
    }
  }

  return [...byKey.values()]
    .sort((left, right) => (right.values.at(-1) ?? 0) - (left.values.at(-1) ?? 0))
    .map((resolution) => resolution.jokerBindings);
}

function enumerateRunResolutions(cards: Card[], jokerCards: Card[], aceMode: "low" | "high") {
  const values = cards.map((card) => rankToSequenceValue(card.rank, aceMode)).sort((left, right) => left - right);
  const duplicates = new Set(values);

  if (duplicates.size !== values.length) {
    return [];
  }

  const suit = cards[0]?.suit;

  if (!suit) {
    return [];
  }

  const totalLength = cards.length + jokerCards.length;
  const limitHigh = aceMode === "high" ? 14 : 13;
  const limitLow = aceMode === "low" ? 1 : 2;
  const minimumStart = Math.max(limitLow, values[values.length - 1] - totalLength + 1);
  const maximumStart = Math.min(values[0], limitHigh - totalLength + 1);
  const resolutions: { values: number[]; jokerBindings: JokerBinding[] }[] = [];

  for (let start = minimumStart; start <= maximumStart; start += 1) {
    const sequence = Array.from({ length: totalLength }, (_, index) => start + index);
    const includesNaturals = values.every((value) => sequence.includes(value));

    if (!includesNaturals) {
      continue;
    }

    const representedValues = sequence.filter((value) => !values.includes(value));

    if (representedValues.length !== jokerCards.length) {
      continue;
    }

    resolutions.push({
      values: sequence,
      jokerBindings: jokerCards.map((jokerCard, index) => ({
        joker_id: jokerCard.id,
        rank: sequenceValueToRank(representedValues[index], aceMode),
        suit
      }))
    });
  }

  return resolutions;
}

function permuteSuits(suits: readonly NonNullable<Card["suit"]>[], length: number, prefix: NonNullable<Card["suit"]>[] = []): NonNullable<Card["suit"]>[][] {
  if (prefix.length === length) {
    return [prefix];
  }

  const combinations: NonNullable<Card["suit"]>[][] = [];

  for (const suit of suits) {
    if (prefix.includes(suit)) {
      continue;
    }

    combinations.push(...permuteSuits(suits, length, [...prefix, suit]));
  }

  return combinations;
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
