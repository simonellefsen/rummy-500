import { describe, expect, it } from "vitest";

import { findSuggestedLayoffs } from "./meld-options";
import { analyzeMeld, scoreHand } from "./rules";
import type { Card } from "./types";

function card(rank: Card["rank"], suit: Card["suit"], id: string): Card {
  return {
    id,
    deck: 1,
    rank,
    suit,
    isJoker: rank === "JOKER"
  };
}

describe("analyzeMeld", () => {
  it("accepts natural sets", () => {
    const result = analyzeMeld([
      card("8", "hearts", "8h"),
      card("8", "clubs", "8c"),
      card("8", "spades", "8s")
    ]);

    expect(result.isValid).toBe(true);
    expect(result.kind).toBe("set");
  });

  it("accepts runs with a joker", () => {
    const result = analyzeMeld([
      card("Q", "hearts", "qh"),
      card("K", "hearts", "kh"),
      card("JOKER", null, "jk")
    ]);

    expect(result.isValid).toBe(true);
    expect(result.kind).toBe("run");
  });

  it("rejects mixed-suit runs", () => {
    const result = analyzeMeld([
      card("4", "hearts", "4h"),
      card("5", "clubs", "5c"),
      card("6", "hearts", "6h")
    ]);

    expect(result.isValid).toBe(false);
  });
});

describe("scoreHand", () => {
  it("adds melded cards and subtracts deadwood", () => {
    const total = scoreHand({
      melded: [card("10", "hearts", "10h"), card("10", "clubs", "10c"), card("10", "spades", "10s")],
      laidOff: [card("5", "hearts", "5h")],
      deadwood: [card("Q", "diamonds", "qd"), card("A", "clubs", "ac")]
    });

    expect(total).toBe(10);
  });
});

describe("findSuggestedLayoffs", () => {
  it("suggests adding a fourth card to a set on the table", () => {
    const queenDiamonds = card("Q", "diamonds", "qd");
    const suggestions = findSuggestedLayoffs(
      [
        {
          type: "set",
          cards: [card("Q", "spades", "qs"), card("Q", "clubs", "qc"), card("Q", "hearts", "qh")]
        }
      ],
      queenDiamonds
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.kind).toBe("set");
    expect(suggestions[0]?.meldIndex).toBe(0);
  });

  it("suggests extending a run on the table", () => {
    const sevenHearts = card("7", "hearts", "7h");
    const suggestions = findSuggestedLayoffs(
      [
        {
          type: "run",
          cards: [card("4", "hearts", "4h"), card("5", "hearts", "5h"), card("6", "hearts", "6h")]
        }
      ],
      sevenHearts
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.kind).toBe("run");
  });
});
