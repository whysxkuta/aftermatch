(async function(){
  async function getMe(){ try{ const r=await fetch('/api/auth/me',{credentials:'include'}); return (await r.json()).user||null; }catch{return null;} }
  const me = await getMe();
  window.__me = me;
  window.showToast = window.showToast || function(msg,type='error'){ let root=document.getElementById('toastRoot'); if(!root){ root=document.createElement('div'); root.id='toastRoot'; root.className='toast-root'; document.body.appendChild(root); } const t=document.createElement('div'); t.className=`toast toast-${type}`; t.textContent=msg; root.appendChild(t); requestAnimationFrame(()=>t.classList.add('toast-show')); setTimeout(()=>{t.classList.remove('toast-show'); setTimeout(()=>t.remove(),220)},3200); };
  document.body.classList.add('glass-body');
  const topbar = document.querySelector('.topbar'); if(topbar) topbar.remove();
  const shell=document.createElement('div'); shell.className='app-shell';
  const sidebar=document.createElement('aside'); sidebar.className='glass-sidebar';
  const current=location.pathname;
  const profileHref = me ? `/player.html?id=${encodeURIComponent(me.id)}` : '/auth.html?mode=login';
  const icons={
    home:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
    tournaments:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10"/><path d="M8 4v4a4 4 0 0 0 8 0V4"/><path d="M6 4H4a3 3 0 0 0 3 3"/><path d="M18 4h2a3 3 0 0 1-3 3"/><path d="M12 12v4"/><path d="M9 21h6"/></svg>',
    profile:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>',
    team:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M3 20a5 5 0 0 1 10 0"/><path d="M11 20a5 5 0 0 1 10 0"/></svg>',
    login:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M21 21V3"/></svg>',
    logout:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 7l5 5-5 5"/><path d="M19 12H7"/><path d="M3 21V3"/></svg>'
  };
  const items=[['/','aftermatch.ru',icons.home,true],['/tournaments.html','Турниры',icons.tournaments], [profileHref,'Профиль',icons.profile], ['/team-page.html','Команда',icons.team]];
  if (me) items.push(['/chats.html','Чаты','<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v10H7l-3 3V5Z"/></svg>']);
  sidebar.innerHTML=`<div class="sidebar-brand"><div class="sidebar-logo"></div><div><div class="sidebar-title">aftermatch.ru</div></div></div><nav class="sidebar-nav"></nav><div class="sidebar-bottom"></div>`;
  const nav=sidebar.querySelector('.sidebar-nav');
  items.forEach(([href,label,icon,home])=>{ const a=document.createElement('a'); a.className='sidebar-link'; a.href=href; if((home && (current==='/'||current==='/index.html')) || (!home && current===href)) a.classList.add('active'); a.innerHTML=`<span class="sidebar-icon">${icon}</span><span class="sidebar-text">${label}</span>`; nav.appendChild(a); });
  const bottom=sidebar.querySelector('.sidebar-bottom');
  if(me){ const btn=document.createElement('button'); btn.className='sidebar-create'; btn.innerHTML=`<span class="sidebar-icon">${icons.logout}</span><span class="sidebar-text">Выйти</span>`; btn.onclick=async()=>{await fetch('/api/auth/logout',{method:'POST',credentials:'include'}); location.href='/';}; bottom.appendChild(btn); }
  else { const a=document.createElement('a'); a.className='sidebar-create'; a.href='/auth.html?mode=login'; a.innerHTML=`<span class="sidebar-icon">${icons.login}</span><span class="sidebar-text">Войти</span>`; bottom.appendChild(a); }
  const main=document.createElement('main'); main.className='app-main';
  while(document.body.firstChild) main.appendChild(document.body.firstChild);
  shell.append(sidebar,main); document.body.appendChild(shell);
})();
