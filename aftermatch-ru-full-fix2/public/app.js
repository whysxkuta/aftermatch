
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

  const sbtnWrap = document.createElement("div");
  sbtnWrap.innerHTML = '<button class="icon-btn" id="openGlobalSearch" title="Поиск"><img src="/src/SearchMenu.ico" alt="Поиск" class="nav-icon-img" /></button>';
  nav.prepend(sbtnWrap);

  const modal = document.createElement("div");
  modal.className = "search-modal hidden";
  modal.innerHTML = `
    <div class="search-modal-backdrop"></div>
    <div class="search-modal-card">
      <div class="search-modal-head">
        <div class="search-modal-title">Поиск</div>
        <button class="icon-btn" id="closeSearchModal">✕</button>
      </div>
      <div class="search-input-wrap">
        <span>🔎</span>
        <input id="globalSearchInput" placeholder="Игрок или команда" />
      </div>
      <div id="globalSearchResults" class="search-results"><div class="small" style="padding:12px;">Начни вводить запрос.</div></div>
    </div>`;
  document.body.appendChild(modal);

  const openSearch = () => modal.classList.remove("hidden");
  const closeSearch = () => modal.classList.add("hidden");
  document.getElementById("openGlobalSearch")?.addEventListener("click", openSearch);
  modal.querySelector(".search-modal-backdrop")?.addEventListener("click", closeSearch);
  modal.querySelector("#closeSearchModal")?.addEventListener("click", closeSearch);

  let st = null;
  modal.querySelector("#globalSearchInput")?.addEventListener("input", e => {
    clearTimeout(st);
    st = setTimeout(() => runSearch(e.target.value.trim()), 150);
  });

  async function runSearch(q) {
    const box = modal.querySelector("#globalSearchResults");
    if (!q) { box.innerHTML = '<div class="small" style="padding:12px;">Начни вводить запрос.</div>'; return; }
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { credentials: "include" });
    const data = await j(res);
    if (!res.ok || !data) { box.innerHTML = `<div class="small" style="padding:12px;">${(data && data.error) ? data.error : 'Ошибка поиска.'}</div>`; return; }
    const players = data.players || [];
    const teams = data.teams || [];
    box.innerHTML = `
      <div class="search-group">
        <div class="search-group-title">Игроки</div>
        ${players.length ? players.map(p => `
          <a class="search-item" href="/player.html?id=${encodeURIComponent(p.id)}">
            <div class="search-avatar" style="${p.avatar_url ? `background-image:url(${p.avatar_url});background-size:cover;background-position:center;` : ``}"></div>
            <div style="flex:1"><div><b>${esc(p.nickname)}</b> ${p.online ? '<span class="online-dot"></span><span class="small">online</span>' : ''}</div><div class="small">${esc(p.steam_profile_name || '')}</div></div>
          </a>`).join("") : '<div class="small muted">Ничего не найдено</div>'}
      </div>
      <div class="search-group">
        <div class="search-group-title">Команды</div>
        ${teams.length ? teams.map(t => `
          <a class="search-item" href="/team-page.html?id=${encodeURIComponent(t.id)}">
            <div class="search-avatar" style="${t.avatar_url ? `background-image:url(${t.avatar_url});background-size:cover;background-position:center;` : ``}"></div>
            <div style="flex:1"><div><b>${t.tag ? '['+esc(t.tag)+'] ' : ''}${esc(t.name)}</b></div></div>
          </a>`).join("") : '<div class="small muted">Ничего не найдено</div>'}
      </div>`;
  }

  const notifWrap = document.createElement("div");
  notifWrap.className = "notif";
  notifWrap.innerHTML = '<button class="icon-btn" id="notifBtn" title="Уведомления"><img src="/src/Notification.ico" alt="Уведомления" class="nav-icon-img" /><span id="notifCount" class="notif-count" style="display:none">0</span></button><div id="notifPanel" class="notif-panel hidden"></div>';
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
