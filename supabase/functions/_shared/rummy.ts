export type Suit = "clubs" | "diamonds" | "hearts" | "spades";
export type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "JOKER";

export interface JokerBinding {
  joker_id: string;
  rank: Exclude<Rank, "JOKER">;
  suit: Suit;
}

export type TableMeld = {
  owner_user_id?: string;
  type?: "set" | "run";
  cards?: Card[];
  points?: number;
  created_at?: string;
  joker_bindings?: JokerBinding[];
};

export interface Card {
  id: string;
  deck: number;
  rank: Rank;
  suit: Suit | null;
  isJoker: boolean;
}

export interface MeldAnalysis {
  kind: "set" | "run" | "invalid";
  isValid: boolean;
  points: number;
  reason?: string;
  jokerBindings?: JokerBinding[];
}

export interface SuggestedDiscardPickupUse {
  type: "meld" | "layoff";
  kind: "set" | "run";
  cardIds?: string[];
  meldIndex?: number;
}

export function scoreCard(card: Card) {
  if (card.isJoker || card.rank === "A") {
    return 15;
  }

  if (card.rank === "J" || card.rank === "Q" || card.rank === "K") {
    return 10;
  }

  return Number(card.rank);
}

export function scoreCards(cards: Card[]) {
  return cards.reduce((total, card) => total + scoreCard(card), 0);
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
    const result = analyzeLayoff(meld, requiredCard);

    if (!result.isValid || result.kind === "invalid") {
      continue;
    }

    suggestions.push({
      type: "layoff",
      kind: result.kind,
      meldIndex
    });
  }

  return suggestions;
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

  if (!naturals.every((card) => card.rank === targetRank)) {
    return invalidMeld("Natural cards in a set must share the same rank.");
  }

  const suitSet = new Set(naturals.map((card) => card.suit));

  if (suitSet.size !== naturals.length) {
    return invalidMeld("Sets cannot repeat the same suit.");
  }

  const jokerCards = cards.filter((card) => card.isJoker);
  const missingSuits = (["clubs", "diamonds", "hearts", "spades"] as Suit[]).filter((suit) => !suitSet.has(suit));

  if (jokerCards.length > missingSuits.length) {
    return invalidMeld("Not enough distinct suits remain to place jokers in this set.");
  }

  const jokerBindings = jokerCards.map((jokerCard, index) => ({
    joker_id: jokerCard.id,
    rank: targetRank as Exclude<Rank, "JOKER">,
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

  if (!naturals.every((card) => card.suit === suit)) {
    return invalidMeld("Natural cards in a run must share the same suit.");
  }

  const lowResolution = resolveRunJokers(naturals, jokerCards, "low");
  const highResolution = resolveRunJokers(naturals, jokerCards, "high");

  if (!lowResolution && !highResolution) {
    return invalidMeld("Cards do not form a valid run.");
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

function canFormRun(cards: Card[], jokers: number, aceMode: "low" | "high") {
  const values = cards.map((card) => rankToSequenceValue(card.rank, aceMode)).sort((left, right) => left - right);
  const duplicates = new Set(values);

  if (duplicates.size !== values.length) {
    return false;
  }

  let gapsToFill = 0;

  for (let index = 1; index < values.length; index += 1) {
    const gap = values[index] - values[index - 1] - 1;

    if (gap < 0) {
      return false;
    }

    gapsToFill += gap;
  }

  if (gapsToFill > jokers) {
    return false;
  }

  const minimumValue = values[0];
  const maximumValue = values[values.length - 1];
  const leftoverJokers = jokers - gapsToFill;
  const roomBelow = aceMode === "low" ? minimumValue - 1 : minimumValue - 2;
  const roomAbove = aceMode === "high" ? 14 - maximumValue : 13 - maximumValue;

  return leftoverJokers <= roomBelow + roomAbove;
}

function rankToSequenceValue(rank: Rank, aceMode: "low" | "high") {
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

function resolveRunJokers(cards: Card[], jokerCards: Card[], aceMode: "low" | "high") {
  const values = cards.map((card) => rankToSequenceValue(card.rank, aceMode)).sort((left, right) => left - right);
  const duplicates = new Set(values);

  if (duplicates.size !== values.length) {
    return null;
  }

  const missingValues: number[] = [];

  for (let index = 1; index < values.length; index += 1) {
    const previousValue = values[index - 1];
    const currentValue = values[index];

    for (let value = previousValue + 1; value < currentValue; value += 1) {
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

function sequenceValueToRank(value: number, aceMode: "low" | "high"): Exclude<Rank, "JOKER"> {
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

  return String(value) as Exclude<Rank, "JOKER">;
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
