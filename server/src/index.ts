import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_PORT } from "../../shared/src/constants";
import { mountApi } from "./api";
import { PenaltyRoom } from "./rooms/PenaltyRoom";
import { SubbuteoRoom } from "./rooms/SubbuteoRoom";
import { loadStore } from "./store";

loadStore();

const app = express();
app.use(cors());
mountApi(app);

// Serve the built client (single-origin deploy). In dev, Vite proxies /api here.
const clientDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/matchmake).*/, (_req, res) => res.sendFile(join(clientDist, "index.html")));
}

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// Each minigame is an independent room module — add new games here only.
gameServer.define("penalty", PenaltyRoom);
gameServer.define("subbuteo", SubbuteoRoom);

const port = Number(process.env.PORT) || SERVER_PORT;
gameServer.listen(port).then(() => {
  console.log(`[footVSball] server listening on http://localhost:${port}`);
});
