import { Client, Room } from "colyseus.js";
import { SERVER_PORT } from "../../../shared/src/constants";
import type { GameId } from "../../../shared/src/types";
import { session } from "../state";

/**
 * Transport abstraction: the game UIs speak to a GameChannel and never know
 * whether the opponent is a remote human (Colyseus room) or the local
 * offline bot emulator. Both sides use the same shared game logic.
 */
export interface GameChannel {
  send(type: string, payload?: unknown): void;
  on(type: string, cb: (payload: any) => void): void;
  onLeave(cb: () => void): void;
  leave(): void;
}

function wsEndpoint(): string {
  if (import.meta.env.DEV) return `ws://${location.hostname}:${SERVER_PORT}`;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

export class ColyseusChannel implements GameChannel {
  private constructor(private room: Room) {}

  static async join(gameId: GameId, vsBot: boolean): Promise<ColyseusChannel> {
    const client = new Client(wsEndpoint());
    const opts = { token: session.token, vsBot };
    const room = vsBot ? await client.create(gameId, opts) : await client.joinOrCreate(gameId, opts);
    return new ColyseusChannel(room);
  }

  send(type: string, payload?: unknown): void {
    this.room.send(type, payload);
  }

  on(type: string, cb: (payload: any) => void): void {
    this.room.onMessage(type, cb);
  }

  onLeave(cb: () => void): void {
    this.room.onLeave(() => cb());
    this.room.onError(() => cb());
  }

  leave(): void {
    this.room.leave(true).catch(() => {});
  }
}

/** Base for offline emulators: in-process message bus with async dispatch. */
export class LocalChannelBase implements GameChannel {
  private handlers = new Map<string, ((p: any) => void)[]>();
  private leaveCbs: (() => void)[] = [];
  protected closed = false;

  /** Client -> "server" (override in subclasses). */
  send(_type: string, _payload?: unknown): void {}

  on(type: string, cb: (payload: any) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }

  onLeave(cb: () => void): void {
    this.leaveCbs.push(cb);
  }

  /** "Server" -> client. */
  protected emit(type: string, payload?: unknown): void {
    if (this.closed) return;
    setTimeout(() => {
      if (this.closed) return;
      for (const cb of this.handlers.get(type) ?? []) cb(payload);
    }, 0);
  }

  leave(): void {
    this.closed = true;
    this.dispose();
  }

  protected dispose(): void {}
}
