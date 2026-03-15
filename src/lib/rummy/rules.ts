import { cardLabel, rankToSequenceValue } from "./cards";
import type { Card, HandScoreInput, MeldAnalysis } from "./types";

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

  return {
    kind: "set",
    isValid: true,
    points: scoreCards(cards)
  };
}

function analyzeRun(cards: Card[]): MeldAnalysis {
  const naturals = cards.filter((card) => !card.isJoker);
  const jokers = cards.length - naturals.length;

  if (naturals.length === 0) {
    return invalidMeld("Runs need at least one natural card.");
  }

  const suit = naturals[0].suit;
  const sameSuit = naturals.every((card) => card.suit === suit);

  if (!sameSuit) {
    return invalidMeld("Natural cards in a run must share the same suit.");
  }

  const canRunLow = canFormRun(naturals, jokers, "low");
  const canRunHigh = canFormRun(naturals, jokers, "high");

  if (!canRunLow && !canRunHigh) {
    return invalidMeld(
      `Cards do not form a valid run: ${cards.map((card) => cardLabel(card)).join(", ")}`
    );
  }

  return {
    kind: "run",
    isValid: true,
    points: scoreCards(cards)
  };
}

function canFormRun(cards: Card[], jokers: number, aceMode: "low" | "high"): boolean {
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

function invalidMeld(reason: string): MeldAnalysis {
  return {
    kind: "invalid",
    isValid: false,
    points: 0,
    reason
  };
}
