import { describe, expect, it } from "vitest";

import { findSuggestedJokerRetrievals, findSuggestedLayoffs, findSuggestedMelds } from "./meld-options";
import { analyzeLayoff, analyzeMeld, scoreHand } from "./rules";
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
    expect(result.jokerBindings?.[0]).toMatchObject({ joker_id: "jk", rank: "A", suit: "hearts" });
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

  it("does not reinterpret a fixed joker when laying off", () => {
    const result = analyzeLayoff(
      {
        type: "run",
        cards: [card("6", "clubs", "6c"), card("7", "clubs", "7c"), card("JOKER", null, "jk")],
        joker_bindings: [{ joker_id: "jk", rank: "8", suit: "clubs" }]
      },
      card("4", "clubs", "4c")
    );

    expect(result.isValid).toBe(false);
  });
});

describe("findSuggestedJokerRetrievals", () => {
  it("suggests replacing a fixed joker with the exact represented card", () => {
    const suggestions = findSuggestedJokerRetrievals(
      [
        {
          type: "set",
          cards: [card("9", "spades", "9s"), card("9", "hearts", "9h"), card("JOKER", null, "jk")],
          joker_bindings: [{ joker_id: "jk", rank: "9", suit: "clubs" }]
        }
      ],
      card("9", "clubs", "9c"),
      true
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.jokerId).toBe("jk");
  });
});

describe("findSuggestedMelds", () => {
  it("prefers natural melds before joker-based melds", () => {
    const suggestions = findSuggestedMelds(
      [
        card("9", "clubs", "9c"),
        card("9", "hearts", "9h"),
        card("9", "diamonds", "9d"),
        card("JOKER", null, "jk")
      ],
      "9c"
    );

    expect(suggestions[0]).toMatchObject({
      kind: "set",
      cards: expect.arrayContaining([expect.objectContaining({ id: "9h" }), expect.objectContaining({ id: "9d" })])
    });
    expect(suggestions[0]?.cards.some((candidate) => candidate.id === "jk")).toBe(false);
  });

  it("returns multiple natural run suggestions around the selected card before joker runs", () => {
    const suggestions = findSuggestedMelds(
      [
        card("7", "clubs", "7c"),
        card("8", "clubs", "8c"),
        card("9", "clubs", "9c"),
        card("10", "clubs", "10c"),
        card("JOKER", null, "jk")
      ],
      "9c"
    );

    const naturalRuns = suggestions.filter(
      (suggestion) => suggestion.kind === "run" && suggestion.cards.every((candidate) => !candidate.isJoker)
    );

    expect(naturalRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cards: expect.arrayContaining([expect.objectContaining({ id: "7c" }), expect.objectContaining({ id: "8c" })])
        }),
        expect.objectContaining({
          cards: expect.arrayContaining([expect.objectContaining({ id: "8c" }), expect.objectContaining({ id: "10c" })])
        })
      ])
    );
    expect(suggestions[0]?.cards.some((candidate) => candidate.id === "jk")).toBe(false);
  });
});
