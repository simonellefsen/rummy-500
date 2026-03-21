export const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;
export const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K"
] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number] | "JOKER";
export type PlayerId = string;

export interface Card {
  id: string;
  deck: number;
  rank: Rank;
  suit: Suit | null;
  isJoker: boolean;
}

export interface JokerBinding {
  joker_id: string;
  rank: Exclude<Rank, "JOKER">;
  suit: Suit;
}

export interface GameVariants {
  aceCanBeLow: boolean;
  aceCanBeHigh: boolean;
  minimumInitialMeldPoints: number;
  mustDiscardToGoOut: boolean;
  visibleDiscardPile: boolean;
  allowJokerRetrieval: boolean;
}

export interface GameConfig {
  playerCount: number;
  decks: number;
  jokers: number;
  cardsPerPlayer: number;
  maxPlayers: number;
  variants: GameVariants;
}

export interface DealResult {
  hands: Record<PlayerId, Card[]>;
  discardPile: Card[];
  stock: Card[];
}

export interface MeldAnalysis {
  kind: "set" | "run" | "invalid";
  isValid: boolean;
  points: number;
  reason?: string;
  jokerBindings?: JokerBinding[];
}

export interface TableMeld {
  owner_user_id?: string;
  type?: "set" | "run";
  cards?: Card[];
  points?: number;
  created_at?: string;
  joker_bindings?: JokerBinding[];
}

export interface HandScoreInput {
  melded: Card[];
  laidOff: Card[];
  deadwood: Card[];
}
