import { t } from "../i18n";
import { addFriendReq, fetchFriends } from "../net/rest";
import { session } from "../state";
import { toast } from "../ui/fx";
import { register } from "../ui/nav";
import { Screen, h } from "../ui/router";
import { tabbar, topbar } from "../ui/shell";

function friends(): Screen {
  const root = h("div", { style: "display:flex;flex-direction:column;min-height:100dvh" });
  root.appendChild(topbar());
  const screen = h("div", { class: "screen" });
  screen.appendChild(h("h2", { class: "screen__title" }, t("friends")));

  // Your shareable ID.
  const idRow = h("div", { class: "list-row" });
  idRow.appendChild(h("span", { class: "grow" }, t("yourId")));
  idRow.appendChild(h("strong", {}, session.user?.id ?? "—"));
  screen.appendChild(idRow);

  // Add friend by ID.
  const addRow = h("div", { style: "display:flex;gap:8px;margin:10px 0 18px" });
  const input = h("input", { class: "input", placeholder: t("friendIdPlaceholder"), style: "text-align:left;flex:1" });
  const addBtn = h("button", { class: "btn", style: "font-size:1rem;padding:10px 18px" }, "+");
  addBtn.addEventListener("click", async () => {
    const id = input.value.trim();
    if (!id) return;
    try {
      await addFriendReq(id);
      toast(t("friendAdded"));
      input.value = "";
      load();
    } catch {
      toast(t("friendNotFound"), "error");
    }
  });
  addRow.append(input, addBtn);
  screen.appendChild(addRow);

  const list = h("div", {});
  screen.appendChild(list);

  async function load(): Promise<void> {
    list.innerHTML = "";
    try {
      const { friends: fl } = await fetchFriends();
      if (!fl.length) {
        list.appendChild(h("p", { class: "muted", style: "text-align:center" }, t("noFriends")));
        return;
      }
      for (const f of fl) {
        const row = h("div", { class: "list-row" });
        row.appendChild(h("div", { class: "avatar", style: "width:38px;height:38px;font-size:1.1rem" }, "🧑"));
        row.appendChild(h("span", { class: "grow" }, f.name));
        row.appendChild(h("span", { class: "meta" }, `Lv ${f.level} · ⚽${f.stats.penalty.rating} · 🎯${f.stats.subbuteo.rating}`));
        list.appendChild(row);
      }
    } catch {
      list.appendChild(h("p", { class: "muted", style: "text-align:center" }, t("connectionLost")));
    }
  }

  root.appendChild(screen);
  root.appendChild(tabbar("friends"));
  load();
  return { el: root };
}

register("friends", friends);
