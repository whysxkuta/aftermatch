(async function () {
  function esc(s) {
    return (s ?? "").toString().replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  async function readJson(res) {
    try { return await res.json(); } catch { return null; }
  }

  const nav = document.querySelector(".nav");
  const brand = document.querySelector(".brand-title");
  if (brand) {
    brand.innerHTML = '<a href="/" style="color:inherit;text-decoration:none;">aftermatch.ru</a>';
  }
  document.querySelectorAll(".hero-title").forEach(el => el.textContent = "aftermatch.ru");
  if (!nav) return;

  window.showToast = function (message, type = "error") {
    let root = document.getElementById("toastRoot");
    if (!root) {
      root = document.createElement("div");
      root.id = "toastRoot";
      root.className = "toast-root";
      document.body.appendChild(root);
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message || "Ошибка";
    root.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("toast-show"));
    setTimeout(() => {
      toast.classList.remove("toast-show");
      setTimeout(() => toast.remove(), 220);
    }, 3200);
  };

  let me = null;
  try {
    const r = await fetch("/api/auth/me", { credentials: "include" });
    const d = await readJson(r);
    me = d?.user || null;
  } catch {
    me = null;
  }

  const heroAuth = document.getElementById("heroAuth");
  if (me && heroAuth) heroAuth.style.display = "none";

  nav.innerHTML = "";

  function makeLink(href, text, className = "nav-btn-link") {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    a.className = className;
    return a;
  }

  function makeButton(text, onClick, className = "nav-btn") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.className = className;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function makeIconButton({ id, title, iconSrc }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = id;
    btn.title = title;
    btn.className = "icon-btn plain-icon-btn";

    const img = document.createElement("img");
    img.src = iconSrc;
    img.alt = title;
    img.className = "nav-icon-img";
    btn.appendChild(img);

    return btn;
  }

  function getProfileUrl() {
    if (!me?.id) return "/login.html";
    return `/player.html?id=${encodeURIComponent(me.id)}`;
  }

  function mountTournamentSearch() {
    const page = location.pathname.replace(/\/+/g, "/");
    const allowed = page === "/" || page === "/index.html" || page === "/tournaments.html";
    if (!allowed) return;

    const topbarInner = document.querySelector(".topbar-inner");
    const brandEl = document.querySelector(".brand");
    if (!topbarInner || !brandEl) return;

    let existing = document.querySelector(".topbar-search-wrap");
    if (existing) existing.remove();

    const wrap = document.createElement("div");
    wrap.className = "topbar-search-wrap";
    wrap.innerHTML = `
      <div class="topbar-search">
        <input id="topbarTournamentSearch" placeholder="Поиск турнира..." />
      </div>
    `;

    topbarInner.insertBefore(wrap, nav);

    const input = wrap.querySelector("#topbarTournamentSearch");
    const params = new URLSearchParams(location.search);
    const q = params.get("q") || "";
    if (input) input.value = q;

    input?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const value = input.value.trim();
      if (!value) {
        location.href = "/tournaments.html";
        return;
      }
      location.href = `/tournaments.html?q=${encodeURIComponent(value)}`;
    });
  }

  async function logout() {
    try {
      const res = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include"
      });
      if (!res.ok) {
        const data = await readJson(res);
        showToast(data?.error || "Не удалось выйти");
        return;
      }
      location.href = "/";
    } catch {
      showToast("Не удалось выйти");
    }
  }

  async function actInvite(id, action) {
    const url = action === "accept"
      ? `/api/team-invites/${id}/accept`
      : `/api/team-invites/${id}/decline`;

    const res = await fetch(url, { method: "POST", credentials: "include" });
    const data = await readJson(res);
    if (!res.ok) {
      showToast((data && data.error) ? data.error : `Ошибка (${res.status})`);
      return;
    }
    loadNotifications(true);
  }

  async function loadNotifications(renderPanel = false) {
    const countEl = document.getElementById("notifCount");
    const bodyEl = document.getElementById("notifPanelBody");

    try {
      const res = await fetch("/api/notifications", { credentials: "include" });
      const data = await readJson(res);
      const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
      const actionable = items.filter(i => ["team_invite", "veto_start", "match_room"].includes(i.type));

      if (countEl) {
        if (actionable.length > 0) {
          countEl.style.display = "inline-flex";
          countEl.textContent = String(actionable.length);
        } else {
          countEl.style.display = "none";
        }
      }

      if (!renderPanel || !bodyEl) return;

      bodyEl.innerHTML = items.length ? items.map(i => `
        <div class="notif-item">
          <div class="notif-item-title">${esc(i.title || "Уведомление")}</div>
          <div class="small">${esc(i.body || i.text || "")}</div>
          ${i.type === "team_invite"
            ? `<div class="notif-actions">
                 <button class="mini-btn primary" data-acc="${i.id}">Принять</button>
                 <button class="mini-btn" data-dec="${i.id}">Отклонить</button>
               </div>`
            : (i.href ? `<a class="small" href="${i.href}">Открыть</a>` : "")}
        </div>
      `).join("") : `<div class="notif-empty">Нет уведомлений</div>`;

      bodyEl.querySelectorAll("[data-acc]").forEach(btn => {
        btn.addEventListener("click", () => actInvite(btn.dataset.acc, "accept"));
      });
      bodyEl.querySelectorAll("[data-dec]").forEach(btn => {
        btn.addEventListener("click", () => actInvite(btn.dataset.dec, "decline"));
      });
    } catch {
      if (countEl) countEl.style.display = "none";
      if (renderPanel && bodyEl) bodyEl.innerHTML = `<div class="notif-empty">Не удалось загрузить уведомления.</div>`;
    }
  }

  function openNotificationsPanel(anchor) {
    let panel = document.getElementById("notifPanel");
    if (panel) {
      panel.remove();
      return;
    }

    panel = document.createElement("div");
    panel.id = "notifPanel";
    panel.className = "notif-panel";
    panel.innerHTML = `
      <div class="notif-panel-head">Уведомления</div>
      <div id="notifPanelBody" class="notif-panel-body">Загрузка...</div>
    `;
    document.body.appendChild(panel);

    const rect = anchor.getBoundingClientRect();
    panel.style.top = `${rect.bottom + window.scrollY + 10}px`;
    panel.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;

    const closeOnOutside = (e) => {
      if (!panel.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
        panel.remove();
        document.removeEventListener("mousedown", closeOnOutside);
      }
    };
    document.addEventListener("mousedown", closeOnOutside);

    loadNotifications(true);
  }

  mountTournamentSearch();

  if (me) {
    const notifBtn = makeIconButton({
      id: "notifBtn",
      title: "Уведомления",
      iconSrc: "/src/Notification.ico"
    });
    const notifCount = document.createElement("span");
    notifCount.id = "notifCount";
    notifCount.className = "notif-count";
    notifCount.style.display = "none";
    notifCount.textContent = "0";
    notifBtn.appendChild(notifCount);
    notifBtn.addEventListener("click", () => openNotificationsPanel(notifBtn));

    nav.appendChild(notifBtn);
    nav.appendChild(makeLink("/tournaments.html", "Турниры"));
    nav.appendChild(makeLink(getProfileUrl(), "Профиль"));
    nav.appendChild(makeButton("Выход", logout, "nav-btn"));

    loadNotifications(false);
    setInterval(() => loadNotifications(false), 15000);
  } else {
    nav.appendChild(makeLink("/tournaments.html", "Турниры"));
    nav.appendChild(makeLink("/login.html", "Вход"));
    nav.appendChild(makeLink("/register.html", "Регистрация"));
  }
})();
