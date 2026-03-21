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

  if (!naturals.every((card) => card.suit === suit)) {
    return invalidMeld("Natural cards in a run must share the same suit.");
  }

  const jokerBindingOptions = getRunBindingOptions(cards);

  if (jokerBindingOptions.length === 0) {
    return invalidMeld("Cards do not form a valid run.");
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
  const missingSuits = (["clubs", "diamonds", "hearts", "spades"] as Suit[]).filter((suit) => !suitSet.has(suit));

  if (jokerCards.length > missingSuits.length) {
    return [];
  }

  return permuteSuits(missingSuits, jokerCards.length).map((suits) =>
    jokerCards.map((jokerCard, index) => ({
      joker_id: jokerCard.id,
      rank: targetRank as Exclude<Rank, "JOKER">,
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

function permuteSuits(suits: readonly Suit[], length: number, prefix: Suit[] = []): Suit[][] {
  if (prefix.length === length) {
    return [prefix];
  }

  const combinations: Suit[][] = [];

  for (const suit of suits) {
    if (prefix.includes(suit)) {
      continue;
    }

    combinations.push(...permuteSuits(suits, length, [...prefix, suit]));
  }

  return combinations;
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
