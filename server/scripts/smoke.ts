/**
 * End-to-end smoke test against a running server (npm run start).
 *   npx tsx scripts/smoke.ts
 * 1. Creates guests via REST.
 * 2. Plays a full penalty match vs bot (checks rewards/economy).
 * 3. Plays penalty human-vs-human (both clients scripted).
 * 4. Opens a subbuteo room vs bot, plays one flick, checks snapshots.
 */
import { Client, Room } from "colyseus.js";

const HTTP = "http://localhost:2567";
const WS = "ws://localhost:2567";

async function rest<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${HTTP}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

function waitMsg<T = any>(room: Room, type: string, timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting "${type}"`)), timeoutMs);
    room.onMessage(type, (m: T) => {
      clearTimeout(to);
      resolve(m);
    });
  });
}

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function penaltyVsBot(token: string): Promise<void> {
  const client = new Client(WS);
  const room = await client.create("penalty", { token, vsBot: true });
  const start = await waitMsg<any>(room, "match_start", 10000);
  check("penalty vsBot: match_start", start.players?.[1]?.isBot === true);

  const endP = waitMsg<any>(room, "match_end", 180000);
  room.onMessage("phase", (msg: any) => {
    if (msg.shooterIdx === start.youAre) {
      setTimeout(() => room.send("shoot", { tx: 0.7, ty: 0.6, power: 0.7, curve: 0.1 }), 300);
    } else {
      setTimeout(() => room.send("dive", { col: -1, row: 0 }), 300);
    }
  });
  let results = 0;
  room.onMessage("result", () => results++);
  const end = await endP;
  check("penalty vsBot: match_end", typeof end.winnerIdx === "number");
  // Shootouts can legally end early once the margin is unreachable.
  check("penalty vsBot: >=6 kicks resolved", results >= 6);
  check("penalty vsBot: rewards present (unranked)", end.rewards && end.rewards.coins > 0 && end.rewards.ratingDelta === 0);
  room.leave();
}

async function penaltyPvP(tokenA: string, tokenB: string): Promise<void> {
  const cA = new Client(WS);
  const cB = new Client(WS);
  const roomA = await cA.joinOrCreate("penalty", { token: tokenA });
  const startA = waitMsg<any>(roomA, "match_start", 10000);
  const roomB = await cB.joinOrCreate("penalty", { token: tokenB });
  const startB = waitMsg<any>(roomB, "match_start", 10000);
  const [sA, sB] = await Promise.all([startA, startB]);
  check("penalty PvP: same room", roomA.roomId === roomB.roomId);
  check("penalty PvP: seats 0/1", sA.youAre !== sB.youAre);

  // Randomized play so sudden death converges quickly.
  const script = (room: Room, me: number) => {
    room.onMessage("phase", (msg: any) => {
      if (msg.shooterIdx === me) {
        const tx = [-0.8, -0.3, 0, 0.3, 0.8][Math.floor(Math.random() * 5)];
        setTimeout(() => room.send("shoot", { tx, ty: Math.random(), power: 0.4 + Math.random() * 0.6, curve: 0 }), 250);
      } else {
        const col = [-1, 0, 1][Math.floor(Math.random() * 3)];
        const row = [0, 1, 2][Math.floor(Math.random() * 3)];
        setTimeout(() => room.send("dive", { col, row }), 250);
      }
    });
    room.onMessage("result", () => {});
  };
  script(roomA, sA.youAre);
  script(roomB, sB.youAre);
  const [endA, endB] = await Promise.all([
    waitMsg<any>(roomA, "match_end", 180000),
    waitMsg<any>(roomB, "match_end", 180000),
  ]);
  check("penalty PvP: both got match_end", !!endA && !!endB);
  check("penalty PvP: ranked rewards", endA.rewards !== null && typeof endA.rewards.ratingDelta === "number");
  check("penalty PvP: consistent winner", endA.winnerIdx === endB.winnerIdx);
  roomA.leave();
  roomB.leave();
}

async function subbuteoVsBot(token: string): Promise<void> {
  const client = new Client(WS);
  const room = await client.create("subbuteo", { token, vsBot: true });
  const start = await waitMsg<any>(room, "match_start", 10000);
  check("subbuteo vsBot: match_start", start.players?.[1]?.isBot === true);
  const board = await waitMsg<any>(room, "board", 10000);
  check("subbuteo vsBot: board has 8 discs", board.discs?.length === 8);

  let snaps = 0;
  room.onMessage("snap", () => snaps++);
  const flickOk = waitMsg<any>(room, "flick_ok", 30000);
  room.onMessage("turn", (msg: any) => {
    if (msg.team === start.youAre) {
      const disc = start.youAre === 0 ? 1 : 5;
      setTimeout(() => room.send("flick", { disc, dx: 0.1, dy: start.youAre === 0 ? -0.9 : 0.9 }), 300);
    }
  });
  await flickOk;
  await new Promise((r) => setTimeout(r, 4000));
  check("subbuteo vsBot: snapshots streamed", snaps > 5);
  room.leave();
}

async function friendChallenge(tokenA: string, tokenB: string): Promise<void> {
  const cA = new Client(WS);
  const cB = new Client(WS);
  const roomA = await cA.create("penalty", { token: tokenA, privateMatch: true });
  const startA = waitMsg<any>(roomA, "match_start", 15000);
  // The invite code is the room ID.
  const roomB = await cB.joinById(roomA.roomId, { token: tokenB });
  const startB = waitMsg<any>(roomB, "match_start", 15000);
  const [sA, sB] = await Promise.all([startA, startB]);
  check("friend challenge: joined by code", roomB.roomId === roomA.roomId);
  check("friend challenge: both human (no bot)", !sA.players[0].isBot && !sA.players[1].isBot);
  check("friend challenge: seats 0/1", sA.youAre !== sB.youAre);
  roomA.leave();
  roomB.leave();
  await new Promise((r) => setTimeout(r, 500));
}

(async () => {
  const a = await rest<any>("/auth/guest", { name: "SmokeA" });
  const b = await rest<any>("/auth/guest", { name: "SmokeB" });
  check("guest auth", !!a.token && !!b.token);

  await friendChallenge(a.token, b.token);

  const coinsBefore = a.user.coins;
  await penaltyVsBot(a.token);
  const me = await rest<any>("/me", undefined, a.token);
  check("economy: coins increased after match", me.user.coins > coinsBefore);

  await penaltyPvP(a.token, b.token);
  await subbuteoVsBot(a.token);

  const lb = await rest<any>("/leaderboard/penalty");
  check("leaderboard non-empty", lb.entries.length >= 2);

  console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("SMOKE CRASH:", e);
  process.exit(1);
});
