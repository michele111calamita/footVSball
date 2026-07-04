import type { GameId, MatchStartMsg } from "../../../shared/src/types";
import { t } from "../i18n";
import { ColyseusChannel, GameChannel } from "../net/channel";
import { LocalPenaltyChannel } from "../local/localPenalty";
import { LocalSubbuteoChannel } from "../local/localSubbuteo";
import { session } from "../state";
import { toast } from "../ui/fx";
import { go, register } from "../ui/nav";
import { Screen, h } from "../ui/router";

export type Mode = "online" | "bot" | "offline" | "friend";

/** Matchmaking screen: shows the queue, offers the bot fallback, launches the game. */
function pregame(params: { gameId: GameId; auto?: Mode }): Screen {
  const { gameId } = params;
  const el = h("div", { class: "screen" });
  const box = h("div", { class: "center" });
  el.appendChild(box);

  let channel: GameChannel | null = null;
  let done = false;

  function renderIdle(): void {
    box.innerHTML = "";
    box.appendChild(h("div", { class: "splash__slide-emoji" }, gameId === "penalty" ? "🥅" : "🎯"));
    box.appendChild(h("h2", {}, gameId === "penalty" ? t("penaltyTitle") : t("subbuteoTitle")));
    const online = h("button", { class: "btn btn--block" }, t("playOnline"));
    online.addEventListener("click", () => start("online"));
    const friend = h("button", { class: "btn btn--block", style: "background:var(--info)" }, t("challengeFriend"));
    friend.addEventListener("click", () => renderFriend());
    const bot = h("button", { class: "btn btn--secondary btn--block" }, t("playVsBot"));
    bot.addEventListener("click", () => start(session.offline ? "offline" : "bot"));
    const back = h("button", { class: "btn btn--ghost btn--block" }, t("cancel"));
    back.addEventListener("click", () => go("home"));
    box.append(online, friend, bot, back);
    if (session.offline) {
      online.setAttribute("disabled", "true");
      friend.setAttribute("disabled", "true");
    }
  }

  /** Friend challenge: create (shows invite code) or join by code. */
  function renderFriend(): void {
    box.innerHTML = "";
    box.appendChild(h("h2", {}, t("challengeFriend")));

    const create = h("button", { class: "btn btn--block" }, t("createChallenge"));
    create.addEventListener("click", async () => {
      box.innerHTML = "";
      box.appendChild(h("div", { class: "spinner" }));
      try {
        const ch = await ColyseusChannel.createPrivate(gameId);
        channel = ch;
        wireChannel();
        box.innerHTML = "";
        box.appendChild(h("p", { class: "muted" }, t("shareCodeHint")));
        const codeEl = h("div", {
          class: "display",
          style: "font-size:2.6rem;letter-spacing:.18em;background:rgba(0,0,0,.3);border-radius:16px;padding:10px 22px;cursor:pointer",
        }, ch.roomId);
        codeEl.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(ch.roomId);
            toast(t("copied"));
          } catch { /* clipboard unavailable */ }
        });
        box.appendChild(codeEl);
        box.appendChild(h("div", { class: "spinner", style: "width:28px;height:28px" }));
        box.appendChild(h("p", { class: "muted" }, t("waitingFriend")));
        const cancel = h("button", { class: "btn btn--ghost" }, t("cancel"));
        cancel.addEventListener("click", () => {
          channel?.leave();
          channel = null;
          renderIdle();
        });
        box.appendChild(cancel);
      } catch {
        toast(t("connectionLost"), "error");
        renderIdle();
      }
    });

    const joinWrap = h("div", { style: "display:flex;gap:8px;width:100%" });
    const input = h("input", { class: "input", placeholder: t("codePlaceholder"), style: "flex:1;text-transform:none" });
    const joinBtn = h("button", { class: "btn btn--secondary" }, t("joinNow"));
    joinBtn.addEventListener("click", async () => {
      const code = input.value.trim();
      if (!code) return;
      joinBtn.classList.add("btn--loading");
      try {
        channel = await ColyseusChannel.joinByCode(code);
        wireChannel();
      } catch {
        joinBtn.classList.remove("btn--loading");
        toast(t("invalidCode"), "error");
      }
    });
    joinWrap.append(input, joinBtn);

    const back = h("button", { class: "btn btn--ghost btn--block" }, t("cancel"));
    back.addEventListener("click", () => renderIdle());
    box.append(create, h("p", { class: "muted" }, t("joinChallenge")), joinWrap, back);
  }

  function renderSearching(): void {
    box.innerHTML = "";
    box.appendChild(h("div", { class: "spinner" }));
    box.appendChild(h("h2", {}, t("searching")));
    box.appendChild(h("p", { class: "muted" }, t("botFallback")));
    const cancel = h("button", { class: "btn btn--ghost" }, t("cancel"));
    cancel.addEventListener("click", () => {
      channel?.leave();
      channel = null;
      renderIdle();
    });
    box.appendChild(cancel);
  }

  function wireChannel(mode: Mode = "friend"): void {
    channel!.on("match_start", (msg: MatchStartMsg) => {
      if (done) return;
      done = true;
      go(gameId === "penalty" ? "game-penalty" : "game-subbuteo", { channel, start: msg, mode });
    });
    channel!.onLeave(() => {
      if (!done) {
        toast(t("connectionLost"), "error");
        renderIdle();
      }
    });
  }

  async function start(mode: Mode): Promise<void> {
    renderSearching();
    let usedMode = mode;
    try {
      if (mode === "offline") {
        channel = gameId === "penalty" ? new LocalPenaltyChannel() : new LocalSubbuteoChannel();
      } else {
        channel = await ColyseusChannel.join(gameId, mode === "bot");
      }
    } catch {
      // Server unreachable: degrade to the local bot (offline handling).
      session.offline = true;
      toast(t("offlineMode"));
      usedMode = "offline";
      channel = gameId === "penalty" ? new LocalPenaltyChannel() : new LocalSubbuteoChannel();
    }
    wireChannel(usedMode);
  }

  if (params.auto === "friend") renderFriend();
  else if (params.auto) start(params.auto);
  else renderIdle();

  return {
    el,
    destroy: () => {
      if (!done) channel?.leave();
    },
  };
}

register("pregame", pregame);
