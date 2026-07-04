/** Ball skin colors (mirror of server shop items — cosmetic only). */
export const SKIN_COLORS: Record<string, [string, string]> = {
  classic: ["#ffffff", "#222222"],
  fire: ["#ff7a1a", "#7a1500"],
  neon: ["#39ff88", "#0a5c2e"],
  gold: ["#ffd23e", "#8a6a00"],
  galaxy: ["#7b5bff", "#1a1040"],
};

export function skinColors(id: string | undefined): [string, string] {
  return SKIN_COLORS[id ?? "classic"] ?? SKIN_COLORS.classic;
}
