import { getLang, setLang, t } from "../i18n";
import { rename } from "../net/rest";
import { saveSession, session } from "../state";
import { confirmModal, toast } from "../ui/fx";
import { go, register } from "../ui/nav";
import { Screen, h } from "../ui/router";
import { tabbar, topbar } from "../ui/shell";

function profile(): Screen {
  const root = h("div", { style: "display:flex;flex-direction:column;min-height:100dvh" });
  root.appendChild(topbar());
  const screen = h("div", { class: "screen" });
  screen.appendChild(h("h2", { class: "screen__title" }, t("profile")));
  const u = session.user;

  // Stats.
  screen.appendChild(h("h3", { style: "margin-bottom:8px" }, t("stats")));
  for (const [gameKey, label] of [["penalty", t("penaltyTitle")], ["subbuteo", t("subbuteoTitle")]] as const) {
    const s = u?.stats[gameKey];
    const row = h("div", { class: "list-row" });
    row.appendChild(h("span", { class: "grow" }, label));
    row.appendChild(h("span", { class: "meta" }, `${t("wins")}: ${s?.wins ?? 0} · ${t("losses")}: ${s?.losses ?? 0}`));
    row.appendChild(h("strong", {}, String(s?.rating ?? 1000)));
    screen.appendChild(row);
  }

  // Rename.
  screen.appendChild(h("h3", { style: "margin:16px 0 8px" }, t("changeName")));
  const nameRow = h("div", { style: "display:flex;gap:8px" });
  const input = h("input", { class: "input", value: u?.name ?? "", maxlength: "20", style: "flex:1" });
  const saveBtn = h("button", { class: "btn", style: "font-size:1rem;padding:10px 18px" }, t("save"));
  saveBtn.addEventListener("click", async () => {
    try {
      await rename(input.value.trim());
      go("profile");
    } catch {
      toast(t("connectionLost"), "error");
    }
  });
  nameRow.append(input, saveBtn);
  screen.appendChild(nameRow);

  // Language.
  screen.appendChild(h("h3", { style: "margin:16px 0 8px" }, t("language")));
  const seg = h("div", { class: "seg" });
  for (const l of ["it", "en"] as const) {
    const b = h("button", { class: getLang() === l ? "on" : "" }, l.toUpperCase());
    b.addEventListener("click", () => {
      setLang(l);
      go("profile");
    });
    seg.appendChild(b);
  }
  screen.appendChild(seg);

  // Reset guest account.
  const logout = h("button", { class: "btn btn--danger btn--block", style: "margin-top:auto" }, t("logout"));
  logout.addEventListener("click", async () => {
    const ok = await confirmModal(t("logout"), t("logoutConfirm"), t("confirm"), t("cancel"));
    if (!ok) return;
    saveSession(null, null);
    go("splash");
  });
  screen.appendChild(logout);

  root.appendChild(screen);
  root.appendChild(tabbar("profile"));
  return { el: root };
}

register("profile", profile);
