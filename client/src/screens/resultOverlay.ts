import type { MatchEndMsg } from "../../../shared/src/types";
import { t } from "../i18n";
import { refreshMe } from "../net/rest";
import { session } from "../state";
import { confetti, haptic, sfx } from "../ui/fx";
import { h } from "../ui/router";

/** End-of-match overlay: win/lose animation, rewards, rematch / home. */
export function showResult(
  msg: MatchEndMsg,
  youAre: 0 | 1,
  onRematch: () => void,
  onHome: () => void,
): HTMLElement {
  const won = msg.winnerIdx === youAre;
  const draw = msg.winnerIdx === -1;

  const el = h("div", { class: "result-overlay" });
  const title = h("h1", { class: won ? "win" : draw ? "" : "lose" }, draw ? t("draw") : won ? t("win") : t("lose"));
  el.appendChild(title);
  el.appendChild(h("div", { class: "final-score" }, `${msg.score[0]} - ${msg.score[1]}`));
  if (msg.reason !== "finished") {
    el.appendChild(h("p", { class: "muted" }, t("opponentLeft")));
  }

  if (msg.rewards) {
    const chips = h("div", { class: "reward-chips" });
    chips.appendChild(h("span", { class: "pill" }, `🪙 +${msg.rewards.coins}`));
    chips.appendChild(h("span", { class: "pill" }, `⭐ +${msg.rewards.xp} XP`));
    const d = msg.rewards.ratingDelta;
    chips.appendChild(h("span", { class: "pill" }, `📈 ${d >= 0 ? "+" : ""}${d}`));
    el.appendChild(chips);
  }

  const row = h("div", { class: "row" });
  const rematch = h("button", { class: "btn" }, t("rematch"));
  rematch.addEventListener("click", () => { el.remove(); onRematch(); });
  const home = h("button", { class: "btn btn--secondary" }, t("backHome"));
  home.addEventListener("click", () => { el.remove(); onHome(); });
  row.append(rematch, home);
  el.appendChild(row);

  if (won) {
    confetti(2500);
    sfx.win();
    haptic([60, 40, 60, 40, 120]);
  } else if (!draw) {
    sfx.lose();
    haptic(200);
  }

  // Profile changed server-side (coins/xp/rating) — refresh the cache.
  if (!session.offline) refreshMe().catch(() => {});

  document.body.appendChild(el);
  return el;
}
