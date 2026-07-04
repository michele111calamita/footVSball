// ---- Shared message & domain types (client <-> server) ----

export type GameId = "penalty" | "subbuteo";

export interface PlayerInfo {
  id: string;
  name: string;
  level: number;
  rating: number;
  isBot: boolean;
  ballSkin?: string;
}

// ---------- Penalty ----------

/** Shot in goal space: tx in [-1,1] (left..right), ty in [0,1] (ground..crossbar). */
export interface Shot {
  tx: number;
  ty: number;
  /** 0..1 — drag length. More power = faster ball, less accuracy. */
  power: number;
  /** -1..1 — lateral curve applied mid-flight. */
  curve: number;
}

/** Keeper dive on the 3x3 grid. col: -1|0|1, row: 0(low)|1(mid)|2(high). */
export interface Dive {
  col: -1 | 0 | 1;
  row: 0 | 1 | 2;
}

export type ShotOutcome = "goal" | "saved" | "post" | "out";

export interface ShotResult {
  outcome: ShotOutcome;
  /** Final ball position in goal space (may exceed bounds on miss). */
  bx: number;
  by: number;
  zoneCol: -1 | 0 | 1;
  zoneRow: 0 | 1 | 2;
  flightMs: number;
  shot: Shot;
  dive: Dive | null;
}

export interface PenaltyPhaseMsg {
  kickIndex: number;
  round: number;
  shooterIdx: 0 | 1;
  shotTimeoutMs: number;
  suddenDeath: boolean;
}

export interface PenaltyResultMsg extends ShotResult {
  kickIndex: number;
  score: [number, number];
  kicksTaken: [number, number];
}

// ---------- Subbuteo ----------

export interface Body2D {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  m: number;
}

export interface Disc extends Body2D {
  team: 0 | 1;
}

export interface SubbuteoState {
  ball: Body2D;
  discs: Disc[];
}

export interface FlickMsg {
  disc: number;
  /** Normalized impulse direction * power (|v| <= 1). */
  dx: number;
  dy: number;
}

export interface SubbuteoSnapshot {
  t: number;
  ball: [number, number];
  discs: [number, number][];
  moving: boolean;
}

export interface TurnMsg {
  team: 0 | 1;
  turnIndex: number;
  turnMs: number;
}

// ---------- Common match messages ----------

export interface MatchStartMsg {
  gameId: GameId;
  players: [PlayerInfo, PlayerInfo];
  youAre: 0 | 1;
}

export interface Rewards {
  coins: number;
  xp: number;
  ratingDelta: number;
}

export interface MatchEndMsg {
  winnerIdx: 0 | 1 | -1; // -1 = draw
  score: [number, number];
  reason: "finished" | "forfeit" | "disconnect";
  rewards: Rewards | null; // null for bots/offline
}

// ---------- REST ----------

export interface UserProfile {
  id: string;
  name: string;
  level: number;
  xp: number;
  coins: number;
  gems: number;
  ballSkin: string;
  ownedSkins: string[];
  friends: string[];
  stats: Record<GameId, { wins: number; losses: number; draws: number; rating: number }>;
  createdAt: number;
}

export interface LeaderboardEntry {
  id: string;
  name: string;
  level: number;
  rating: number;
  wins: number;
}

export interface ShopItem {
  id: string;
  name: string;
  kind: "ballSkin";
  costCoins: number;
  costGems: number;
  emojiFallback: string;
  colors: [string, string];
}
