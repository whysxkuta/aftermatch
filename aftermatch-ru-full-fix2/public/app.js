
(async function () {
  function esc(s){return (s??"").toString().replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  async function j(res){try{return await res.json();}catch{return null;}}

  const nav = document.querySelector(".nav");
  const brand = document.querySelector(".brand-title");
  if (brand) brand.innerHTML = '<a href="/" style="color:inherit;text-decoration:none;">aftermatch.ru</a>';
  document.querySelectorAll(".hero-title").forEach(el => el.textContent = "aftermatch.ru");
  if (!nav) return;


window.showToast = function(message, type = "error") {
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
    const d = await r.json();
    me = d?.user || null;
  } catch {}

  nav.querySelectorAll('a[href="/"], a[href="/index.html"]').forEach(a => a.remove());
  const login = nav.querySelector('a[href="/login.html"]');
  const reg = nav.querySelector('a[href="/register.html"]');
  if (me) {
    if (login) login.remove();
    if (reg) reg.remove();
  }
  const heroAuth = document.getElementById("heroAuth");
  if (me && heroAuth) heroAuth.style.display = "none";

const page = location.pathname.replace(/\/+/g, "/");
const isHome = page === "/" || page === "/index.html";
const isTournamentsPage = page === "/tournaments.html";

// tournaments nav button
const tournamentsLink = document.createElement("a");
tournamentsLink.href = "/tournaments.html";
tournamentsLink.className = "nav-tournaments-link";
tournamentsLink.textContent = "Турниры";
nav.prepend(tournamentsLink);

// centered tournament search lives in topbar now
if (isHome || isTournamentsPage) {
  const topbarInner = document.querySelector(".topbar-inner");
  if (topbarInner) {
    const wrap = document.createElement("div");
    wrap.className = "topbar-search-wrap";
    wrap.innerHTML = `
      <div class="topbar-search">
        <input id="topbarTournamentSearch" placeholder="Поиск турнира..." />
      </div>
    `;
    const brandEl = document.querySelector(".brand");
    if (brandEl && brandEl.nextSibling) topbarInner.insertBefore(wrap, nav);
    else topbarInner.appendChild(wrap);

    const input = wrap.querySelector("#topbarTournamentSearch");
    input?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = input.value.trim();
      if (!q) {
        if (!isTournamentsPage) location.href = "/tournaments.html";
        return;
      }
      location.href = `/tournaments.html?q=${encodeURIComponent(q)}`;
    });

    if (isTournamentsPage) {
      const params = new URLSearchParams(location.search);
      const q = params.get("q") || "";
      if (input) input.value = q;
    }
  }
}

  const notifWrap = document.createElement("div");
  notifWrap.className = "notif";
  notifWrap.innerHTML = '<button class="icon-btn plain-icon-btn" id="notifBtn" title="Уведомления"><img src="/src/Notification.ico" alt="Уведомления" class="nav-icon-img" /><span id="notifCount" class="notif-count" style="display:none">0</span></button><div id="notifPanel" class="notif-panel hidden"></div>';
  nav.prepend(notifWrap);

  async function actInvite(id, action){
    const url = action === "accept" ? `/api/team-invites/${id}/accept` : `/api/team-invites/${id}/decline`;
    const res = await fetch(url, { method:"POST", credentials:"include" });
    const data = await j(res);
    if (!res.ok) { alert((data && data.error) ? data.error : `Ошибка (${res.status})`); return; }
    loadNotifications();
  }

  async function loadNotifications(){
    const p = document.getElementById("notifPanel");
    const c = document.getElementById("notifCount");
    const res = await fetch("/api/notifications", { credentials:"include" });
    const data = await j(res);
    const items = data?.items || [];
    const invites = items.filter(i => i.type === "team_invite");
    c.textContent = String(invites.length);
    c.style.display = invites.length ? "inline-flex" : "none";
    p.innerHTML = items.length ? items.map(i => `
      <div class="notif-item">
        <div class="notif-item-title">${esc(i.title)}</div>
        <div class="small">${esc(i.body || "")}</div>
        ${i.type === "team_invite" ? `<div class="notif-actions"><button class="mini-btn primary" data-acc="${i.id}">Принять</button><button class="mini-btn" data-dec="${i.id}">Отклонить</button></div>` : `<a class="small" href="${i.href || '#'}">Открыть</a>`}
      </div>`).join("") : '<div class="small" style="padding:12px;">Нет уведомлений</div>';
    p.querySelectorAll("[data-acc]").forEach(btn => btn.addEventListener("click", () => actInvite(btn.dataset.acc, "accept")));
    p.querySelectorAll("[data-dec]").forEach(btn => btn.addEventListener("click", () => actInvite(btn.dataset.dec, "decline")));
  }

  document.getElementById("notifBtn")?.addEventListener("click", async () => {
    const p = document.getElementById("notifPanel");
    p.classList.toggle("hidden");
    if (!p.classList.contains("hidden")) await loadNotifications();
  });

  if (me) {
    const profile = document.createElement("a");
    profile.href = `/player.html?id=${me.id}`;
    profile.textContent = "Профиль";
    nav.appendChild(profile);
    if (me.role === "admin") {
      const admin = document.createElement("a");
      admin.href = "/admin.html";
      admin.textContent = "Админ";
      nav.appendChild(admin);
    }
  }
})();
