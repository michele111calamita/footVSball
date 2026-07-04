/** Tiny screen router: each screen is a factory returning its root element
 *  and an optional cleanup. Keeps the app dependency-free. */

export interface Screen {
  el: HTMLElement;
  destroy?: () => void;
}

let current: Screen | null = null;

export function show(next: Screen): void {
  const app = document.getElementById("app")!;
  current?.destroy?.();
  app.innerHTML = "";
  app.appendChild(next.el);
  current = next;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  el.append(...children);
  return el;
}
