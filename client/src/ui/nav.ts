import { Screen, show } from "./router";

/** Screen registry — avoids circular imports between screens. */
type ScreenFactory = (params?: any) => Screen;

const registry = new Map<string, ScreenFactory>();

export function register(name: string, factory: ScreenFactory): void {
  registry.set(name, factory);
}

export function go(name: string, params?: unknown): void {
  const f = registry.get(name);
  if (!f) throw new Error(`screen not registered: ${name}`);
  show(f(params));
}
