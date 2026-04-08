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
  const items=[['/','aftermatch.ru','◈',true],['/tournaments.html','Турниры','⌘'],[profileHref,'Профиль','☺'],['/team-page.html','Команда','✦'],[me?'/admin.html':'/auth.html?mode=login','Админка','⚙']];
  sidebar.innerHTML=`<div class="sidebar-brand"><div class="sidebar-logo"></div><div><div class="sidebar-title">aftermatch.ru</div><div class="sidebar-sub">glass competition</div></div></div><nav class="sidebar-nav"></nav><div class="sidebar-bottom"></div>`;
  const nav=sidebar.querySelector('.sidebar-nav');
  items.forEach(([href,label,icon,home])=>{ const a=document.createElement('a'); a.className='sidebar-link'; a.href=href; if((home && (current==='/'||current==='/index.html')) || (!home && current===href)) a.classList.add('active'); a.innerHTML=`<span class="sidebar-icon">${icon}</span><span class="sidebar-text">${label}</span>`; nav.appendChild(a); });
  const bottom=sidebar.querySelector('.sidebar-bottom');
  if(me){ const btn=document.createElement('button'); btn.className='sidebar-create'; btn.textContent='Выйти'; btn.onclick=async()=>{await fetch('/api/auth/logout',{method:'POST',credentials:'include'}); location.href='/';}; bottom.appendChild(btn); }
  else { const a=document.createElement('a'); a.className='sidebar-create'; a.href='/auth.html?mode=login'; a.textContent='Войти'; bottom.appendChild(a); }
  const main=document.createElement('main'); main.className='app-main';
  while(document.body.firstChild) main.appendChild(document.body.firstChild);
  shell.append(sidebar,main); document.body.appendChild(shell);
})();
