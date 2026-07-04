import { Client } from "colyseus.js";

const HTTP = "https://footvsball-mc.fly.dev";
const WS = "wss://footvsball-mc.fly.dev";

async function guest(name: string) {
  const r = await fetch(`${HTTP}/api/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return r.json() as Promise<{ token: string }>;
}

(async () => {
  const a = await guest("ProdA");
  const b = await guest("ProdB");
  console.log("guest auth ok");

  const cA = new Client(WS);
  const cB = new Client(WS);
  const roomA = await cA.create("penalty", { token: a.token, privateMatch: true });
  console.log("private room created, code:", roomA.roomId);

  const gotStart: string[] = [];
  roomA.onMessage("match_start", () => gotStart.push("A"));
  const roomB = await cB.joinById(roomA.roomId, { token: b.token });
  roomB.onMessage("match_start", () => gotStart.push("B"));
  await new Promise((r) => setTimeout(r, 3000));
  console.log("match_start received by:", gotStart.join(",") || "NOBODY");
  roomA.leave();
  roomB.leave();
  process.exit(gotStart.length === 2 ? 0 : 1);
})().catch((e) => {
  console.error("PROD CHECK FAIL:", e.message);
  process.exit(1);
});
