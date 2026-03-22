
import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import openid from "openid";
import { Server as SocketIOServer } from "socket.io";
import { nanoid } from "nanoid";
import { db, initSchema, nowIso } from "./db.js";

initSchema();


function ensureAdminAccount() {
  const admin = db.prepare(`SELECT id FROM users WHERE nickname = ?`).get("root");
  const hash = bcrypt.hashSync("whySxkuta_SC1", 10);

  if (!admin) {
    db.prepare(`INSERT INTO users (id, nickname, password_hash, first_name, last_name, role, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(nanoid(10), "root", hash, "Admin", "Admin", "admin", nowIso());
  } else {
    db.prepare(`UPDATE users SET password_hash = ?, role = 'admin' WHERE nickname = ?`)
      .run(hash, "root");
  }
}

ensureAdminAccount();


const app = express();
console.log('[boot] server starting');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
// API_LOG
app.use((req,res,next)=>{
  if (req.url.startsWith('/api/teams') || req.url.startsWith('/api/team') || req.url.startsWith('/api/notifications')) {
    console.log('[api]', req.method, req.url);
  }
  next();
});
app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser());
// Guard admin page: only logged-in admin can open /admin.html
app.use((req, res, next) => {
  if (req.path === "/admin.html") {
    const s = getSession(req.cookies?.[SESSION_COOKIE]);
    if (!s || !s.user_id) return res.redirect("/login.html");
    const u = db.prepare(`SELECT role FROM users WHERE id = ?`).get(s.user_id);
    if (!u || u.role !== "admin") return res.redirect("/login.html");
    return next();
  }
  return next();
});



const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 4000;

// Фиксированный адрес хоста
const BASE_URL = process.env.BASE_URL || null;

function getPublicBaseUrl(req = null) {
  if (BASE_URL) return BASE_URL.replace(/\/$/, "");
  const proto = req?.headers?.["x-forwarded-proto"] || req?.protocol || "http";
  const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host || `localhost:${PORT}`;
  return `${proto}://${host}`.replace(/\/$/, "");
}

/* ===== helpers ===== */
function randomPassword(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/* ===== sessions ===== */
const SESSION_COOKIE = "lan_session";
const SESSION_TTL_HOURS = 12;

function addHoursIso(hours) {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

function createSession({ userId = null, pendingSteamId64 = null, pendingSteamProfileName = null } = {}) {
  const id = nanoid(32);
  db.prepare(`INSERT INTO sessions (id, user_id, pending_steam_id64, pending_steam_profile_name, expires_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, userId, pendingSteamId64, pendingSteamProfileName, addHoursIso(SESSION_TTL_HOURS), nowIso());
  return id;
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    return null;
  }
  return row;
}

function setSessionCookie(res, sessionId) {
  res.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 7*24*60*60*1000 });
}

function clearSessionCookie(res) { res.clearCookie(SESSION_COOKIE, { path: "/" }); }

function requireAuth(req, res, next) {
  const s = getSession(req.cookies?.[SESSION_COOKIE]);
  if (!s || !s.user_id) return res.status(401).json({ error: "Not authenticated" });
  req.session = s;
  next();
}

function requireAdmin(req, res, next) {
  const s = getSession(req.cookies?.[SESSION_COOKIE]);
  if (!s || !s.user_id) return res.status(401).json({ error: "Not authenticated" });
  const u = db.prepare(`SELECT role FROM users WHERE id = ?`).get(s.user_id);
  if (!u || u.role !== "admin") return res.status(403).json({ error: "Admin only" });
  req.session = s;
  next();
}

function isCaptainOfTeam(teamId, userId) {
  const row = db.prepare(`SELECT role FROM team_members WHERE team_id = ? AND user_id = ?`).get(teamId, userId);
  return !!row && row.role === "captain";
}

function getTeamMembers(teamId) {
  return db.prepare(`
    SELECT u.id AS user_id, u.nickname, u.first_name, u.last_name, u.middle_name, u.steam_id64, u.steam_profile_name, u.avatar_url,
           EXISTS(SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS online,
           tm.role, tm.joined_at
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ?
    ORDER BY CASE tm.role WHEN 'captain' THEN 0 ELSE 1 END, u.nickname ASC
  `).all(nowIso(), teamId);
}

function getUserSideForMatch(matchId, userId) {
  const m = getMatch(matchId);
  if (!m) return null;
  if (isCaptainOfTeam(m.team_a_id, userId)) return "A";
  if (isCaptainOfTeam(m.team_b_id, userId)) return "B";
  return null;
}

function getUserSafeById(id) {
  return db.prepare(`SELECT u.id, u.nickname, u.first_name, u.last_name, u.middle_name, u.steam_id64, u.steam_profile_name, u.avatar_url, u.role, u.created_at,
                            EXISTS(SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS online
                     FROM users u WHERE u.id = ?`).get(nowIso(), id);
}

/* ===== Steam OpenID ===== */

async function fetchSteamAvatarUrl(steamId64) {
  try {
    const url = `https://steamcommunity.com/profiles/${steamId64}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await r.text();

    let m = html.match(/<meta property="og:image" content="([^"]+)"/i);
    if (m) return m[1];

    m = html.match(/<link rel="image_src" href="([^"]+)"/i);
    if (m) return m[1];

    m = html.match(/"avatarFull":"([^"]+)"/i);
    if (m) return m[1].replace(/\\/g, "");
  } catch {}
  return null;
}

async function fetchSteamPersonaName(steamId64) {
  try {
    const url = `https://steamcommunity.com/profiles/${steamId64}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await r.text();

    let m = html.match(/<span class="actual_persona_name">([^<]+)<\/span>/);
    if (m) return m[1].trim();

    const og = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
    if (og) {
      const t = og[1].replace(/^Steam Community ::\s*/, "").trim();
      if (t) return t;
    }
  } catch {}
  return null;
}

function makeRelyingParty(req = null) {
  const base = getPublicBaseUrl(req);
  return new openid.RelyingParty(
    `${base}/auth/steam/return`,
    base,
    true,
    true,
    []
  );
}

app.get("/auth/steam", (req, res) => {
  const rp = makeRelyingParty(req);
  rp.authenticate("https://steamcommunity.com/openid", false, (err, authUrl) => {
    if (err || !authUrl) return res.status(500).send("Steam auth init failed");
    res.redirect(authUrl);
  });
});

app.get("/auth/steam/return", async (req, res) => {
  const rp = makeRelyingParty(req);
  rp.verifyAssertion(req, async (err, result) => {
    if (err || !result?.authenticated || !result?.claimedIdentifier) {
      return res.redirect(`/register.html?err=steam_failed`);
    }

    // Steam OpenID identity обычно выглядит как:
    // https://steamcommunity.com/openid/id/<SteamID64> (иногда с завершающим /)
    const m = String(result.claimedIdentifier).match(/\/id\/(\d+)\/?$/);
    const steamId64 = m ? m[1] : null;
    if (!steamId64) return res.redirect(`/register.html?err=steam_failed`);

    // 1) Если SteamID уже привязан — это логин через Steam
    const existing = db.prepare(`SELECT id FROM users WHERE steam_id64 = ?`).get(steamId64);
    if (existing?.id) {
      const sessionId = createSession({ userId: existing.id });
      setSessionCookie(res, sessionId);
      return res.redirect(`/player.html?id=${existing.id}`);
    }

    // 2) Иначе — это регистрация с подтверждённым Steam
    let sessionId = req.cookies?.[SESSION_COOKIE];
    const session = getSession(sessionId);

    const persona = await fetchSteamPersonaName(steamId64);

    if (!session) {
      sessionId = createSession({ pendingSteamId64: steamId64, pendingSteamProfileName: persona });
      setSessionCookie(res, sessionId);
    } else {
      db.prepare(`UPDATE sessions SET pending_steam_id64 = ?, pending_steam_profile_name = ?, expires_at = ? WHERE id = ?`)
        .run(steamId64, persona, addHoursIso(SESSION_TTL_HOURS), sessionId);
    }

    return res.redirect(`/register.html?steam=${steamId64}`);
  });
});

/* ===== veto helpers ===== */
function buildStepsForBo(bo) {
  if (bo === 1) {
    const steps = [];
    const order = ["A","B","A","B","A","B"];
    for (const by of order) steps.push({ type: "ban", by });
    return steps;
  }
  return [
    { type: "ban",  by: "A" },
    { type: "ban",  by: "B" },
    { type: "pick", by: "A" },
    { type: "pick", by: "B" },
    { type: "ban",  by: "A" },
    { type: "ban",  by: "B" }
  ];
}

function createVetoState(bo, mapPool) {
  return {
    bo,
    steps: buildStepsForBo(bo),
    stepIndex: 0,
    remaining: [...mapPool],
    actions: [],
    picks: { A: [], B: [] },
    decider: null,
    ready: { A: false, B: false }
  };
}

function finalizeMapsIfPossible(veto) {
  if (veto.bo === 1) {
    if (veto.remaining.length === 1) { veto.decider = veto.remaining[0]; return true; }
    return false;
  }
  if (veto.stepIndex >= veto.steps.length) {
    if (veto.remaining.length >= 1) veto.decider = veto.remaining[0];
    return true;
  }
  return false;
}

/* ===== db getters ===== */


function getMyTeam(userId) {
  const membership = db.prepare(`
    SELECT t.*
    FROM team_members tm
    JOIN teams t ON t.id = tm.team_id
    WHERE tm.user_id = ?
    LIMIT 1
  `).get(userId);
  return membership || null;
}

function getTournamentTeams(tournamentId) {
  return db.prepare(`
    SELECT t.id, t.name, t.tag, t.description, t.avatar_url, tr.created_at AS registered_at,
           (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS players_count
    FROM tournament_registrations tr
    JOIN teams t ON t.id = tr.team_id
    WHERE tr.tournament_id = ?
    ORDER BY tr.created_at ASC
  `).all(tournamentId);
}

function hydrateTournament(t) {
  if (!t) return null;
  let mapPool = [];
  try { mapPool = JSON.parse(t.map_pool_json || "[]"); } catch {}
  return {
    ...t,
    map_pool: mapPool,
    has_prizes: Number(t.prize_places || 0) > 0,
    card_badge: Number(t.prize_places || 0) > 0 ? "С призами" : "Без призовых",
        teams_count: (t.teams_count ?? 0),
    prizes: [
      t.prize_1 ? { place: 1, value: t.prize_1 } : null,
      Number(t.prize_places || 0) >= 3 && t.prize_2 ? { place: 2, value: t.prize_2 } : null,
      Number(t.prize_places || 0) >= 3 && t.prize_3 ? { place: 3, value: t.prize_3 } : null,
    ].filter(Boolean)
  };
}

function getTournament(id) { return db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(id); }
function getTeam(id) { return db.prepare(`SELECT * FROM teams WHERE id = ?`).get(id); }
function getServerRow(id) { return db.prepare(`SELECT * FROM servers WHERE id = ?`).get(id); }
function getMatch(id) { return db.prepare(`SELECT * FROM matches WHERE id = ?`).get(id); }

function hydrateMatch(match) {
  if (!match) return null;
  const t = getTournament(match.tournament_id);
  const teamA = getTeam(match.team_a_id);
  const teamB = getTeam(match.team_b_id);
  const serverRow = match.server_id ? getServerRow(match.server_id) : null;
  const veto = match.veto_state_json ? JSON.parse(match.veto_state_json) : null;
  const result = match.result_json ? JSON.parse(match.result_json) : null;
  return { ...match, tournament: t, teamA, teamB, server: serverRow, veto, result };
}

function saveMatchVeto(matchId, veto) {
  db.prepare(`UPDATE matches SET veto_state_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(veto), nowIso(), matchId);
}

function ensureVeto(matchId) {
  const m = getMatch(matchId);
  if (!m) return null;
  const t = getTournament(m.tournament_id);
  if (!t) return null;

  let veto = m.veto_state_json ? JSON.parse(m.veto_state_json) : null;
  if (!veto) {
    const mapPool = JSON.parse(t.map_pool_json);
    veto = createVetoState(t.bo, mapPool);
    saveMatchVeto(matchId, veto);
    db.prepare(`UPDATE matches SET status = ?, updated_at = ? WHERE id = ?`)
      .run("veto", nowIso(), matchId);
  }
  return veto;
}

function publicMatchState(matchId) {
  const m = hydrateMatch(getMatch(matchId));
  if (!m) return null;
  let connect = null;
  if (m.server && m.connect_password) connect = `connect ${m.server.ip}:${m.server.port}; password ${m.connect_password}`;
  else if (m.server) connect = `connect ${m.server.ip}:${m.server.port}`;

  const maps = [];
  if (m.veto) {
    if (m.veto.bo === 1) { if (m.veto.decider) maps.push(m.veto.decider); }
    else { maps.push(...m.veto.picks.A, ...m.veto.picks.B); if (m.veto.decider) maps.push(m.veto.decider); }
  }

  return {
    id: m.id,
    status: m.status,
    tournament: { id: m.tournament.id, name: m.tournament.name, mode: m.tournament.mode, bo: m.tournament.bo, mapPool: JSON.parse(m.tournament.map_pool_json) },
    teamA: { id: m.teamA.id, name: m.teamA.name },
    teamB: { id: m.teamB.id, name: m.teamB.name },
    server: m.server ? { id: m.server.id, name: m.server.name, ip: m.server.ip, port: m.server.port } : null,
    connectPassword: m.connect_password || null,
    connect,
    veto: m.veto,
    maps,
    result: m.result
  };
}

/* ===== Auth API ===== */
app.get("/api/auth/me", (req, res) => {
  const s = getSession(req.cookies?.[SESSION_COOKIE]);
  if (!s || !s.user_id) {
    return res.json({
      user: null,
      pendingSteamId64: s?.pending_steam_id64 || null,
      pendingSteamProfileName: s?.pending_steam_profile_name || null
    });
  }
  const user = getUserSafeById(s.user_id);
  res.json({
    user,
    pendingSteamId64: s.pending_steam_id64 || null,
    pendingSteamProfileName: s.pending_steam_profile_name || null
  });
});


app.get("/api/me/teams", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, tm.role as my_role
    FROM team_members tm
    JOIN teams t ON t.id = tm.team_id
    WHERE tm.user_id = ?
    ORDER BY t.created_at DESC
  `).all(req.session.user_id);
  res.json(rows);
});


app.post("/api/teams/:id/leave", requireAuth, (req, res) => {
  const teamId = String(req.params.id);
  const userId = req.session.user_id;

  const roleRow = db.prepare(`SELECT role FROM team_members WHERE team_id = ? AND user_id = ?`).get(teamId, userId);
  if (!roleRow) return res.status(403).json({ error: "You are not in this team" });

  const membersCount = db.prepare(`SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?`).get(teamId)?.c || 0;

  if (roleRow.role === "captain" && membersCount > 1) {
    return res.status(409).json({ error: "Captain can leave only when members count is 1" });
  }

  db.prepare(`DELETE FROM team_members WHERE team_id = ? AND user_id = ?`).run(teamId, userId);

  const leftCount = db.prepare(`SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?`).get(teamId)?.c || 0;
  if (leftCount === 0) {
    db.prepare(`DELETE FROM team_invites WHERE team_id = ?`).run(teamId);
    db.prepare(`DELETE FROM teams WHERE id = ?`).run(teamId);
    return res.json({ ok: true, deleted: true });
  }

  res.json({ ok: true, deleted: false });
});

app.get("/api/me/team", requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT tm.team_id, tm.role, t.name as team_name, t.tournament_id
    FROM team_members tm
    JOIN teams t ON t.id = tm.team_id
    WHERE tm.user_id = ?
    ORDER BY t.created_at DESC
    LIMIT 1
  `).get(req.session.user_id);

  res.json(row || null);
});


app.post("/api/auth/register", async (req, res) => {
  const s = getSession(req.cookies?.[SESSION_COOKIE]);
  if (!s || !s.pending_steam_id64) return res.status(400).json({ error: "Steam not linked. Use Steam login first." });

  const { nickname, password, firstName, lastName, middleName } = req.body || {};
  if (!nickname || !password || !firstName || !lastName) return res.status(400).json({ error: "Missing fields" });

  const nickExists = db.prepare(`SELECT id FROM users WHERE nickname = ?`).get(nickname);
  if (nickExists) return res.status(409).json({ error: "Nickname already taken" });

  const steamExists = db.prepare(`SELECT id FROM users WHERE steam_id64 = ?`).get(s.pending_steam_id64);
  if (steamExists) return res.status(409).json({ error: "Steam already linked to another account" });

  const userId = nanoid(10);
  const hash = await bcrypt.hash(password, 10);

  db.prepare(`INSERT INTO users (id, nickname, password_hash, first_name, last_name, middle_name, steam_id64, steam_profile_name, role, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'player', ?)`)
    .run(userId, nickname, hash, firstName, lastName, (middleName || null), s.pending_steam_id64, s.pending_steam_profile_name, nowIso());

  db.prepare(`UPDATE sessions SET user_id = ?, pending_steam_id64 = NULL, pending_steam_profile_name = NULL, expires_at = ? WHERE id = ?`)
    .run(userId, addHoursIso(SESSION_TTL_HOURS), s.id);

  res.json({ ok: true, user: getUserSafeById(userId) });
});

app.post("/api/auth/login", async (req, res) => {
  const { nickname, password } = req.body || {};
  if (!nickname || !password) return res.status(400).json({ error: "Missing fields" });

  const row = db.prepare(`SELECT * FROM users WHERE nickname = ?`).get(nickname);
  if (!row) return res.status(401).json({ error: "Invalid credentials" });
  if (row.banned_until && row.banned_until > nowIso()) {
    return res.status(403).json({ error: `Аккаунт заблокирован до ${row.banned_until}${row.ban_reason ? ` • ${row.ban_reason}` : ""}` });
  }

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const sessionId = createSession({ userId: row.id });
  setSessionCookie(res, sessionId);
  res.json({ ok: true, user: getUserSafeById(row.id) });
});

app.post("/api/auth/logout", (req, res) => {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ===== Players API ===== */
app.get("/api/players", (req, res) => {
  const rows = db.prepare(`SELECT id, nickname, first_name, last_name, middle_name, steam_id64, steam_profile_name, avatar_url, role, banned_until, ban_reason, created_at
                           FROM users ORDER BY created_at DESC`).all();
  res.json(rows);
});

app.get("/api/players/:id", (req, res) => {
  const row = getUserSafeById(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

app.patch("/api/players/:id", requireAuth, async (req, res) => {
  const targetId = req.params.id;
  const me = getUserSafeById(req.session.user_id);
  const isAdmin = me?.role === "admin";
  if (!isAdmin && targetId !== me.id) return res.status(403).json({ error: "Forbidden" });

  const { firstName, lastName, password } = req.body || {};
  if (firstName) db.prepare(`UPDATE users SET first_name = ? WHERE id = ?`).run(firstName, targetId);
  if (lastName) db.prepare(`UPDATE users SET last_name = ? WHERE id = ?`).run(lastName, targetId);
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, targetId);
  }

  res.json({ ok: true, player: getUserSafeById(targetId) });
});

app.patch("/api/players/:id/nickname", requireAdmin, (req, res) => {
  const targetId = req.params.id;
  const { nickname } = req.body || {};
  if (!nickname) return res.status(400).json({ error: "Missing nickname" });

  const exists = db.prepare(`SELECT id FROM users WHERE nickname = ? AND id <> ?`).get(nickname, targetId);
  if (exists) return res.status(409).json({ error: "Nickname already taken" });

  db.prepare(`UPDATE users SET nickname = ? WHERE id = ?`).run(nickname, targetId);
  res.json({ ok: true, player: getUserSafeById(targetId) });
});

app.get("/api/players/:id/team", (req, res) => {
  const userId = String(req.params.id);
  const row = db.prepare(`SELECT team_id FROM team_members WHERE user_id = ? LIMIT 1`).get(userId);
  if (!row?.team_id) return res.json({ team: null });

  const team = db.prepare(`SELECT id, name, tag, description, avatar_url FROM teams WHERE id = ?`).get(row.team_id);
  const playersCount = db.prepare(`SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?`).get(row.team_id)?.c || 0;
  res.json({ team, playersCount });
});

/* ===== Tournaments API ===== */
app.get("/api/tournaments", (req, res) => {
  const rows = db.prepare(`
    SELECT t.*,
           (SELECT COUNT(*) FROM tournament_registrations tr WHERE tr.tournament_id = t.id) AS teams_count
    FROM tournaments t
    ORDER BY t.created_at DESC
  `).all();
  res.json(rows.map(hydrateTournament));
});

app.get("/api/tournaments/:id", (req, res) => {
  const row = db.prepare(`
    SELECT t.*,
           (SELECT COUNT(*) FROM tournament_registrations tr WHERE tr.tournament_id = t.id) AS teams_count
    FROM tournaments t
    WHERE t.id = ?
  `).get(String(req.params.id));
  if (!row) return res.status(404).json({ error: "Tournament not found" });

  const t = hydrateTournament(row);
  t.teams = getTournamentTeams(t.id);

  const session = getSession(req.cookies?.[SESSION_COOKIE]);
  if (session?.user_id) {
    const myTeam = getMyTeam(session.user_id);
    t.my_team = myTeam || null;
    t.i_am_captain = !!myTeam && !!db.prepare(`SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND role = 'captain'`).get(myTeam.id, session.user_id);
    t.my_team_registered = !!myTeam && !!db.prepare(`SELECT 1 FROM tournament_registrations WHERE tournament_id = ? AND team_id = ?`).get(t.id, myTeam.id);
    t.is_admin = !!db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'admin'`).get(session.user_id);
  } else {
    t.my_team = null;
    t.i_am_captain = false;
    t.my_team_registered = false;
    t.is_admin = false;
  }

  res.json(t);
});

app.post("/api/tournaments", requireAdmin, (req, res) => {
  const {
    homeHeader,
    pageHeader,
    name,
    description,
    bracketMode,
    mode,
    prizePlaces,
    prize1,
    prize2,
    prize3
  } = req.body || {};

  const cleanName = (name ?? "").toString().trim();
  const cleanDesc = (description ?? "").toString().trim();
  const cleanHome = (homeHeader ?? "").toString().trim();
  const cleanPage = (pageHeader ?? "").toString().trim();
  const cleanMode = (mode ?? "").toString().trim() || "5v5";
  const cleanBracket = (bracketMode ?? "").toString().trim() || "single_elim";
  const places = Number(prizePlaces || 0);

  if (!cleanName) return res.status(400).json({ error: "Название обязательно" });
  if (!cleanMode) return res.status(400).json({ error: "Режим обязателен" });
  if (![0, 1, 3].includes(places)) return res.status(400).json({ error: "Призовые места: 0, 1 или 3" });
  if (places === 1 && !(prize1 ?? "").toString().trim()) return res.status(400).json({ error: "Укажи приз за 1 место" });
  if (places === 3 && (![prize1, prize2, prize3].every(v => (v ?? "").toString().trim()))) return res.status(400).json({ error: "Укажи призы для 1-3 мест" });

  const id = nanoid(10);
  const defaultMaps = ["de_mirage","de_inferno","de_nuke","de_ancient","de_anubis","de_vertigo","de_dust2"];
  db.prepare(`
    INSERT INTO tournaments (
      id, name, description, prize, cover_url, page_cover_url, mode, bracket_mode, bo, map_pool_json,
      prize_places, prize_1, prize_2, prize_3, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    cleanName,
    cleanDesc || null,
    places > 0 ? "configured" : null,
    cleanHome || null,
    cleanPage || cleanHome || null,
    cleanMode,
    cleanBracket,
    3,
    JSON.stringify(defaultMaps),
    places,
    places >= 1 ? (prize1 ?? "").toString().trim() : null,
    places >= 3 ? (prize2 ?? "").toString().trim() : null,
    places >= 3 ? (prize3 ?? "").toString().trim() : null,
    nowIso()
  );

  res.json({ ok: true, id });
});

app.post("/api/teams", requireAuth, (req, res) => {
  const { tournamentId, name, tag } = req.body || {};
  const cleanName = (name ?? "").toString().trim();
  const cleanTag = (tag ?? "").toString().trim();
  const tId = (tournamentId ?? "").toString().trim();

  if (!cleanName) return res.status(400).json({ error: "Team name required" });
  if (!cleanTag) return res.status(400).json({ error: "Team tag required" });

  // admin не играет
  const me = db.prepare(`SELECT role FROM users WHERE id = ?`).get(req.session.user_id);
  if (me?.role === "admin") return res.status(403).json({ error: "Admin cannot create teams" });

  // строго: один игрок = одна команда (вообще)
  const anyTeam = db.prepare(`SELECT team_id FROM team_members WHERE user_id = ?`).get(req.session.user_id);
  if (anyTeam) return res.status(409).json({ error: "You are already in a team" });

  // имя команды уникально (case-insensitive)
  const existingName = db.prepare(`SELECT id FROM teams WHERE lower(name) = lower(?)`).get(cleanName);
  if (existingName) return res.status(409).json({ error: "Team name already taken" });

  let tournamentRow = null;
  if (tId) {
    tournamentRow = getTournament(tId);
    if (!tournamentRow) return res.status(404).json({ error: "Tournament not found" });
  }

  const id = nanoid(10);

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO teams (id, tournament_id, name, tag, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, tournamentRow ? tournamentRow.id : null, cleanName, cleanTag, nowIso());

    // guarantee creator is captain (and only captain) for this new team
    db.prepare(`UPDATE team_members SET role='member' WHERE team_id = ? AND role='captain' AND user_id <> ?`)
      .run(id, req.session.user_id);

    db.prepare(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'captain', ?)`)
      .run(id, req.session.user_id, nowIso());
  });

  try {
    tx();
  } catch (e) {
    return res.status(500).json({ error: "Failed to create team" });
  }

  res.json({ ok: true, id });
});



app.post("/api/teams/:id/set-captain", requireAdmin, (req, res) => {
  const teamId = req.params.id;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  const team = db.prepare(`SELECT * FROM teams WHERE id = ?`).get(teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });
  const user = db.prepare(`SELECT id FROM users WHERE id = ? AND role <> 'admin'`).get(userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const conflict = db.prepare(`
    SELECT tm.team_id FROM team_members tm
    JOIN teams t ON t.id = tm.team_id
    WHERE tm.user_id = ? AND t.tournament_id = ? AND tm.team_id <> ?
  `).get(userId, team.tournament_id, teamId);
  if (conflict) return res.status(409).json({ error: "User already in another team of this tournament" });

  db.prepare(`UPDATE team_members SET role = 'member' WHERE team_id = ? AND role='captain'`).run(teamId);

  const existing = db.prepare(`SELECT role FROM team_members WHERE team_id = ? AND user_id = ?`).get(teamId, userId);
  if (existing) db.prepare(`UPDATE team_members SET role='captain' WHERE team_id=? AND user_id=?`).run(teamId, userId);
  else db.prepare(`INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'captain', ?)`).run(teamId, userId, nowIso());

  res.json({ ok: true });
});

app.post("/api/teams/:id/remove-member", requireAuth, (req, res) => {
  const teamId = req.params.id;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  if (!isCaptainOfTeam(teamId, req.session.user_id)) return res.status(403).json({ error: "Captain only" });
  const row = db.prepare(`SELECT role FROM team_members WHERE team_id=? AND user_id=?`).get(teamId, userId);
  if (!row) return res.status(404).json({ error: "Member not found" });
  if (row.role === "captain") return res.status(400).json({ error: "Cannot remove captain" });
  db.prepare(`DELETE FROM team_members WHERE team_id=? AND user_id=?`).run(teamId, userId);
  res.json({ ok: true });
});

app.post("/api/matches", requireAdmin, (req, res) => {
  const { tournamentId, teamAId, teamBId } = req.body || {};
  if (!tournamentId || !teamAId || !teamBId || teamAId === teamBId) return res.status(400).json({ error: "Bad payload" });

  const t = getTournament(tournamentId);
  if (!t) return res.status(404).json({ error: "Tournament not found" });
  const teamA = getTeam(teamAId);
  const teamB = getTeam(teamBId);
  if (!teamA || !teamB) return res.status(404).json({ error: "Team not found" });
  if (teamA.tournament_id !== tournamentId || teamB.tournament_id !== tournamentId) return res.status(400).json({ error: "Teams must belong to tournament" });

  const capA = db.prepare(`SELECT 1 FROM team_members WHERE team_id=? AND role='captain'`).get(teamAId);
  const capB = db.prepare(`SELECT 1 FROM team_members WHERE team_id=? AND role='captain'`).get(teamBId);
  if (!capA || !capB) return res.status(400).json({ error: "Both teams must have captains" });

  const matchId = nanoid(10);
  db.prepare(`INSERT INTO matches (id, tournament_id, team_a_id, team_b_id, status, server_id, connect_password, veto_state_json, result_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(matchId, tournamentId, teamAId, teamBId, "veto", null, null, null, null, nowIso(), nowIso());
  res.json({ ok: true, id: matchId, url: `${BASE_URL}/match.html?matchId=${matchId}` });
});

/* ===== Servers/Matches API ===== */
app.get("/api/servers", (req, res) => {
  const rows = db.prepare(`SELECT * FROM servers WHERE is_active = 1 ORDER BY name ASC`).all();
  res.json(rows);
});

app.post("/api/servers", requireAdmin, (req, res) => {
  const { name, ip, port, rcon_password } = req.body || {};
  if (!name || !ip || !port) return res.status(400).json({ error: "Bad payload" });
  const id = nanoid(10);
  db.prepare(`INSERT INTO servers (id, name, ip, port, rcon_password, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(id, name, ip, Number(port), rcon_password || "");
  res.json({ id });
});


app.get("/api/matches", (req, res) => {
  const rows = db.prepare(`SELECT * FROM matches ORDER BY created_at DESC`).all();
  const hydrated = rows.map(r => hydrateMatch(r)).filter(Boolean);
  res.json(hydrated.map(m => ({
    id: m.id,
    status: m.status,
    tournament: { id: m.tournament.id, name: m.tournament.name, mode: m.tournament.mode, bo: m.tournament.bo },
    teamA: { id: m.teamA.id, name: m.teamA.name },
    teamB: { id: m.teamB.id, name: m.teamB.name }
  })));
});


app.get("/api/matches/:id/captains", (req, res) => {
  const m = getMatch(req.params.id);
  if (!m) return res.status(404).json({ error: "Not found" });
  const capA = db.prepare(`SELECT user_id FROM team_members WHERE team_id = ? AND role='captain'`).get(m.team_a_id);
  const capB = db.prepare(`SELECT user_id FROM team_members WHERE team_id = ? AND role='captain'`).get(m.team_b_id);
  res.json({ captainA: capA?.user_id || null, captainB: capB?.user_id || null });
});

app.get("/api/matches/:id", (req, res) => {
  const matchId = req.params.id;
  ensureVeto(matchId);
  const state = publicMatchState(matchId);
  if (!state) return res.status(404).json({ error: "Not found" });
  res.json(state);
});

app.post("/api/matches/:id/assign-server", requireAdmin, (req, res) => {
  const matchId = req.params.id;
  const { serverId } = req.body || {};
  const m = getMatch(matchId);
  if (!m) return res.status(404).json({ error: "Not found" });
  const s = getServerRow(serverId);
  if (!s) return res.status(400).json({ error: "Server not found" });

  const pwd = randomPassword(6);
  db.prepare(`UPDATE matches SET server_id = ?, connect_password = ?, updated_at = ? WHERE id = ?`)
    .run(serverId, pwd, nowIso(), matchId);

  io.to(`match:${matchId}`).emit("match:state", publicMatchState(matchId));
  res.json({ ok: true });
});

app.post("/api/matches/:id/report-result", requireAdmin, (req, res) => {
  const matchId = req.params.id;
  const { winnerTeamId, scoreA, scoreB } = req.body || {};
  const m = getMatch(matchId);
  if (!m) return res.status(404).json({ error: "Not found" });

  const state = publicMatchState(matchId);
  const result = { winnerTeamId, score: { a: Number(scoreA ?? 0), b: Number(scoreB ?? 0) }, maps: state.maps };

  db.prepare(`UPDATE matches SET status = ?, result_json = ?, updated_at = ? WHERE id = ?`)
    .run("finished", JSON.stringify(result), nowIso(), matchId);

  io.to(`match:${matchId}`).emit("match:state", publicMatchState(matchId));
  res.json({ ok: true });
});

function parseCookies(cookieHeader = "") {
  const out = {};
  cookieHeader.split(";").forEach(part => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function getUserIdFromSocket(socket) {
  try {
    const cookies = parseCookies(socket.request?.headers?.cookie || "");
    const sid = cookies[SESSION_COOKIE];
    const s = getSession(sid);
    return s?.user_id || null;
  } catch {
    return null;
  }
}

/* ===== Socket.io realtime ===== */
io.on("connection", (socket) => {
  socket.on("match:join", ({ matchId }) => {
    if (!matchId) return;
    socket.join(`match:${matchId}`);
    ensureVeto(matchId);
    socket.emit("match:state", publicMatchState(matchId));
  });

  socket.on("match:ready", ({ matchId, side }) => {
    if (!matchId || !["A","B"].includes(side)) return;
    const userId = getUserIdFromSocket(socket);
    if (!userId) return;
    const allowedSide = getUserSideForMatch(matchId, userId);
    if (allowedSide !== side) return;
    const veto = ensureVeto(matchId);
    if (!veto) return;

    veto.ready[side] = true;
    saveMatchVeto(matchId, veto);

    db.prepare(`UPDATE matches SET status = ?, updated_at = ? WHERE id = ?`)
      .run("veto", nowIso(), matchId);

    io.to(`match:${matchId}`).emit("match:state", publicMatchState(matchId));
  });

  socket.on("veto:action", ({ matchId, side, type, map }) => {
    if (!matchId || !["A","B"].includes(side)) return;
    const userId = getUserIdFromSocket(socket);
    if (!userId) return;
    const allowedSide = getUserSideForMatch(matchId, userId);
    if (allowedSide !== side) return;
    if (!["ban","pick"].includes(type) || !map) return;

    const veto = ensureVeto(matchId);
    if (!veto) return;
    if (!veto.ready.A || !veto.ready.B) return;

    const step = veto.steps[veto.stepIndex];
    if (!step) return;
    if (step.by !== side) return;
    if (step.type !== type) return;
    if (!veto.remaining.includes(map)) return;

    veto.actions.push({ type, by: side, map, at: nowIso() });
    veto.remaining = veto.remaining.filter(m => m !== map);
    if (type === "pick") veto.picks[side].push(map);
    veto.stepIndex += 1;

    const done = finalizeMapsIfPossible(veto);
    if (done && veto.decider) {
      db.prepare(`UPDATE matches SET status = ?, updated_at = ? WHERE id = ?`)
        .run("ready", nowIso(), matchId);
    }

    saveMatchVeto(matchId, veto);
    io.to(`match:${matchId}`).emit("match:state", publicMatchState(matchId));
  });
});

app.post("/api/me/steam/refresh", requireAuth, async (req, res) => {
  const me = db.prepare(`SELECT steam_id64 FROM users WHERE id = ?`).get(req.session.user_id);
  if (!me?.steam_id64) return res.status(400).json({ error: "Steam не привязан" });

  const persona = await fetchSteamPersonaName(me.steam_id64);
  if (!persona) return res.status(502).json({ error: "Не удалось получить ник из Steam" });

  db.prepare(`UPDATE users SET steam_profile_name = ? WHERE id = ?`).run(persona, req.session.user_id);
  res.json({ ok: true, steamProfileName: persona });
});

app.get("/api/notifications", (req, res) => {
  const s = getSession(req.cookies?.[SESSION_COOKIE]);
  const userId = s?.user_id || null;
  const items = [];

  if (userId) {
    const invites = db.prepare(`
      SELECT i.id, i.team_id, i.status, i.created_at,
             t.name as team_name, t.tag as team_tag,
             byu.nickname as invited_by
      FROM team_invites i
      JOIN teams t ON t.id = i.team_id
      JOIN users byu ON byu.id = i.invited_by_user_id
      WHERE i.invited_user_id = ? AND i.status = 'pending'
      ORDER BY i.created_at DESC
      LIMIT 10
    `).all(userId);

    for (const inv of invites) {
      items.push({
        type: "team_invite",
        id: inv.id,
        title: "Приглашение в команду",
        body: `${inv.team_tag ? "["+inv.team_tag+"] " : ""}${inv.team_name} — от ${inv.invited_by}`,
        href: `/team-page.html?id=${inv.team_id}`
      });
    }
  }

  const ts = db.prepare(`
    SELECT id, name, description, prize, created_at
    FROM tournaments
    ORDER BY created_at DESC
    LIMIT 3
  `).all();

  for (const t of ts) {
    items.push({
      type: "tournament",
      id: t.id,
      title: "Открыта регистрация на турнир",
      body: `${t.name}${t.prize ? " • " + t.prize : ""}`,
      href: `/tournament.html?id=${t.id}`
    });
  }

  res.json({ items });
});

app.get("/api/ping", (req,res)=>res.json({ ok:true, ts: Date.now() }));

app.get("/api/version", (req,res)=>res.json({ version:"aftermatch-fix6" }));

// INVITE route (regex) — гарантированно ловит /api/teams/<id>/invite даже если обычный роут не зарегистрировался
app.post(/^\/api\/teams\/([^\/]+)\/invite\/?$/, requireAuth, (req, res) => {
  const teamId = String(req.params[0] || "");
  console.log("[INVITE_REGEX_HIT]", { teamId, by: req.session.user_id, body: req.body });

  const nickname = (req.body?.nickname ?? "").toString().trim();
  if (!nickname) return res.status(400).json({ error: "Укажи ник игрока" });

  const team = db.prepare(`SELECT id FROM teams WHERE id = ?`).get(teamId);
  if (!team) return res.status(404).json({ error: "Команда не найдена" });

  const captain = db.prepare(`SELECT role FROM team_members WHERE team_id = ? AND user_id = ?`).get(teamId, req.session.user_id);
  if (!captain || captain.role !== "captain") return res.status(403).json({ error: "Только капитан может приглашать" });

  const invited = db.prepare(`
    SELECT id, role FROM users
    WHERE lower(nickname) = lower(?)
       OR (steam_profile_name IS NOT NULL AND lower(steam_profile_name) = lower(?))
  `).get(nickname, nickname);

  if (!invited) return res.status(404).json({ error: "Игрок не найден" });
  if (invited.role === "admin") return res.status(400).json({ error: "Нельзя пригласить администратора" });
  if (invited.id === req.session.user_id) return res.status(400).json({ error: "Нельзя пригласить самого себя" });

  const already = db.prepare(`SELECT team_id FROM team_members WHERE user_id = ?`).get(invited.id);
  if (already) return res.status(409).json({ error: "Игрок уже состоит в команде" });

  const exists = db.prepare(`SELECT id FROM team_invites WHERE team_id = ? AND invited_user_id = ? AND status='pending'`).get(teamId, invited.id);
  if (exists) return res.status(409).json({ error: "Приглашение уже отправлено" });

  const inviteId = nanoid(12);
  db.prepare(`
    INSERT INTO team_invites (id, team_id, invited_by_user_id, invited_user_id, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(inviteId, teamId, req.session.user_id, invited.id, new Date().toISOString());

  return res.json({ ok: true, id: inviteId });
});

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function saveDataUrlPng(dataUrl, outPath) {
  if (!dataUrl || typeof dataUrl !== "string") return false;
  const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!m) return false;
  const buf = Buffer.from(m[1], "base64");
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, buf);
  return true;
}

app.get("/api/players/search", requireAuth, (req, res) => {
  const q = (req.query.q ?? "").toString().trim();
  if (!q) return res.json({ players: [] });

  const rows = db.prepare(`
    SELECT id, nickname, steam_profile_name, avatar_url, role
    FROM users
    WHERE lower(nickname) LIKE lower(?) OR (steam_profile_name IS NOT NULL AND lower(steam_profile_name) LIKE lower(?))
    ORDER BY role='admin' ASC, nickname ASC
    LIMIT 10
  `).all(`%${q}%`, `%${q}%`);

  res.json({ players: rows });
});

app.post("/api/team-invites/:id/accept", requireAuth, (req, res) => {
  const inviteId = String(req.params.id);
  const userId = req.session.user_id;

  const inv = db.prepare(`SELECT * FROM team_invites WHERE id = ?`).get(inviteId);
  if (!inv) return res.status(404).json({ error: "Приглашение не найдено" });
  if (inv.invited_user_id !== userId) return res.status(403).json({ error: "Нет доступа" });
  if (inv.status !== "pending") return res.status(409).json({ error: "Приглашение уже обработано" });

  const team = db.prepare(`SELECT id FROM teams WHERE id = ?`).get(inv.team_id);
  if (!team) return res.status(404).json({ error: "Команда не найдена" });

  const already = db.prepare(`SELECT team_id FROM team_members WHERE user_id = ?`).get(userId);
  if (already) return res.status(409).json({ error: "Ты уже в команде" });

  const now = nowIso();
  db.prepare(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'player', ?)`).run(inv.team_id, userId, now);
  db.prepare(`UPDATE team_invites SET status='accepted', responded_at=? WHERE id=?`).run(now, inviteId);

  res.json({ ok: true });
});

app.post("/api/team-invites/:id/decline", requireAuth, (req, res) => {
  const inviteId = String(req.params.id);
  const userId = req.session.user_id;

  const inv = db.prepare(`SELECT * FROM team_invites WHERE id = ?`).get(inviteId);
  if (!inv) return res.status(404).json({ error: "Приглашение не найдено" });
  if (inv.invited_user_id !== userId) return res.status(403).json({ error: "Нет доступа" });
  if (inv.status !== "pending") return res.status(409).json({ error: "Приглашение уже обработано" });

  const now = nowIso();
  db.prepare(`UPDATE team_invites SET status='declined', responded_at=? WHERE id=?`).run(now, inviteId);

  res.json({ ok: true });
});


app.get("/api/search", (req, res) => {
  const qRaw = (req.query?.q ?? "").toString().trim();
  if (!qRaw) return res.json({ players: [], teams: [] });

  const like = `%${qRaw.toLowerCase()}%`;

  try {
    const players = db.prepare(`
      SELECT u.id, u.nickname, u.steam_profile_name, u.avatar_url,
             EXISTS(
               SELECT 1 FROM sessions s
               WHERE s.user_id = u.id AND s.expires_at > ?
             ) AS online
      FROM users u
      WHERE u.role <> 'admin'
        AND (
          lower(u.nickname) LIKE ?
          OR (u.steam_profile_name IS NOT NULL AND lower(u.steam_profile_name) LIKE ?)
        )
      ORDER BY online DESC, u.nickname ASC
      LIMIT 8
    `).all(nowIso(), like, like);

    const teams = db.prepare(`
      SELECT t.id, t.name, t.tag, t.avatar_url
      FROM teams t
      WHERE lower(t.name) LIKE ?
         OR (t.tag IS NOT NULL AND lower(t.tag) LIKE ?)
      ORDER BY t.name ASC
      LIMIT 8
    `).all(like, like);

    return res.json({ players, teams });
  } catch (e) {
    console.error("[search_failed]", e);
    return res.status(500).json({ error: "search_failed" });
  }
});


app.post("/api/me/steam-avatar/refresh", requireAuth, async (req, res) => {
  const me = db.prepare(`SELECT steam_id64 FROM users WHERE id = ?`).get(req.session.user_id);
  if (!me?.steam_id64) return res.status(400).json({ error: "Steam не привязан" });

  const avatarUrl = await fetchSteamAvatarUrl(me.steam_id64);
  if (!avatarUrl) return res.status(502).json({ error: "Не удалось получить аватар из Steam" });

  db.prepare(`UPDATE users SET avatar_url = ? WHERE id = ?`).run(avatarUrl, req.session.user_id);
  res.json({ ok: true, avatarUrl });
});


app.post("/api/me/avatar", requireAuth, (req, res) => {
  const dataUrl = req.body?.dataUrl || req.body?.dataURL || null;
  if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ error: "Missing dataURL" });

  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!m) return res.status(400).json({ error: "Only PNG/JPG/WEBP" });

  const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  const buf = Buffer.from(m[2], "base64");
  const dir = path.join(process.cwd(), "public", "uploads", "avatars");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${req.session.user_id}.${ext}`), buf);

  const url = `/uploads/avatars/${req.session.user_id}.${ext}?v=${Date.now()}`;
  try { db.prepare(`UPDATE users SET avatar_url = ? WHERE id = ?`).run(url, req.session.user_id); } catch (e) {
    return res.status(500).json({ error: "avatar_update_failed" });
  }
  res.json({ ok: true, avatarUrl: url });
});

app.patch("/api/users/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const { nickname, firstName, lastName, middleName } = req.body || {};
  const cleanNick = (nickname ?? "").toString().trim();
  const cleanFirst = (firstName ?? "").toString().trim();
  const cleanLast = (lastName ?? "").toString().trim();
  const cleanMiddle = (middleName ?? "").toString().trim();

  if (!cleanNick || !cleanFirst || !cleanLast) return res.status(400).json({ error: "Bad payload" });

  const exists = db.prepare(`SELECT id FROM users WHERE id = ?`).get(id);
  if (!exists) return res.status(404).json({ error: "Not found" });

  const other = db.prepare(`SELECT id FROM users WHERE lower(nickname)=lower(?) AND id <> ?`).get(cleanNick, id);
  if (other) return res.status(409).json({ error: "Nickname taken" });

  db.prepare(`UPDATE users SET nickname = ?, first_name = ?, last_name = ?, middle_name = ? WHERE id = ?`)
    .run(cleanNick, cleanFirst, cleanLast, cleanMiddle || null, id);

  res.json({ ok: true });
});

app.post("/api/admin/users/:id/make-admin", requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const row = db.prepare(`SELECT id, nickname FROM users WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: "User not found" });
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(id);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/ban", requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const { until, reason } = req.body || {};
  const cleanUntil = (until ?? "").toString().trim();
  const cleanReason = (reason ?? "").toString().trim();
  if (!cleanUntil) return res.status(400).json({ error: "Укажи срок блокировки" });

  const row = db.prepare(`SELECT id FROM users WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: "User not found" });

  db.prepare(`UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?`)
    .run(cleanUntil, cleanReason || null, id);

  // optional logout
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);

  res.json({ ok: true });
});

app.post("/api/admin/users/:id/unban", requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const row = db.prepare(`SELECT id FROM users WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: "User not found" });

  db.prepare(`UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?`).run(id);
  res.json({ ok: true });
});

app.post("/api/tournaments/:id/register-team", requireAuth, (req, res) => {
  const tournamentId = String(req.params.id);
  const userId = req.session.user_id;
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId);
  if (!tournament) return res.status(404).json({ error: "Tournament not found" });

  const team = getMyTeam(userId);
  if (!team) return res.status(409).json({ error: "Сначала создай команду" });

  const captain = db.prepare(`SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND role = 'captain'`).get(team.id, userId);
  if (!captain) return res.status(403).json({ error: "Только капитан может зарегистрировать команду" });

  if (tournament.checkin_until && nowIso() > tournament.checkin_until) {
    return res.status(409).json({ error: "Чеки-ин уже закрыт" });
  }

  const maxTeams = Number(tournament.max_teams || 0);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM tournament_registrations WHERE tournament_id = ?`).get(tournamentId)?.c || 0;
  if (maxTeams > 0 && count >= maxTeams) return res.status(409).json({ error: "Достигнут лимит команд" });

  const exists = db.prepare(`SELECT 1 FROM tournament_registrations WHERE tournament_id = ? AND team_id = ?`).get(tournamentId, team.id);
  if (exists) return res.status(409).json({ error: "Команда уже участвует в турнире" });

  db.prepare(`INSERT INTO tournament_registrations (tournament_id, team_id, registered_by_user_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(tournamentId, team.id, userId, nowIso());

  res.json({ ok: true });
});

app.post("/api/tournaments/:id/remove-team", requireAdmin, (req, res) => {
  const tournamentId = String(req.params.id);
  const teamId = String(req.body?.teamId || "");
  if (!teamId) return res.status(400).json({ error: "teamId required" });

  db.prepare(`DELETE FROM tournament_registrations WHERE tournament_id = ? AND team_id = ?`).run(tournamentId, teamId);
  res.json({ ok: true });
});

app.get("/api/teams/:id", (req, res) => {
  const teamId = String(req.params.id);
  const team = db.prepare(`
    SELECT t.*
    FROM teams t
    WHERE t.id = ?
  `).get(teamId);

  if (!team) return res.status(404).json({ error: "Team not found" });

  const session = getSession(req.cookies?.[SESSION_COOKIE]);
  const userId = session?.user_id || null;
  const myRole = userId
    ? (db.prepare(`SELECT role FROM team_members WHERE team_id = ? AND user_id = ?`).get(teamId, userId)?.role || null)
    : null;

  const members = db.prepare(`
    SELECT u.id AS user_id, u.nickname, u.first_name, u.last_name, u.middle_name, u.steam_id64, u.steam_profile_name, u.avatar_url,
           EXISTS(SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS online,
           tm.role, tm.joined_at
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ?
    ORDER BY CASE tm.role WHEN 'captain' THEN 0 ELSE 1 END, u.nickname ASC
  `).all(nowIso(), teamId);

  const invites = db.prepare(`
    SELECT ti.id, ti.status, ti.created_at,
           iu.nickname AS invitedNickname,
           bu.nickname AS invitedByNickname
    FROM team_invites ti
    JOIN users iu ON iu.id = ti.invited_user_id
    JOIN users bu ON bu.id = ti.invited_by_user_id
    WHERE ti.team_id = ?
    ORDER BY ti.created_at DESC
  `).all(teamId);

  res.json({ team, myRole, members, invites });
});

/** API 404 handler (debug): ensures /api/* returns JSON and logs */
app.use("/api", (req, res) => {
  console.log("[API_404]", req.method, req.originalUrl);
  res.status(404).json({ error: "api_not_found", path: req.originalUrl });
});

app.use("/src", express.static("src", {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".ico")) res.setHeader("Content-Type", "image/x-icon");
  }
}));

// static files (after API routes to avoid POST/404 issues)
app.use("/uploads", express.static("public/uploads"));
app.use(express.static("public"));
app.get("/api/routes", (req, res) => {
  try {
    const out = [];
    const stack = app?._router?.stack || [];
    for (const layer of stack) {
      if (!layer?.route) continue;
      const path = layer.route.path;
      const methods = Object.keys(layer.route.methods || {}).filter(k => layer.route.methods[k]).map(m => m.toUpperCase());
      out.push({ methods, path });
    }
    res.json({ count: out.length, routes: out });
  } catch (e) {
    res.status(500).json({ error: "routes_failed" });
  }
});



server.listen(PORT, "0.0.0.0", () => {
  console.log(`LAN Veto Tournament running on ${getPublicBaseUrl()}`);
});
app.post("/api/teams/:id/avatar", requireAuth, (req, res) => {
  const teamId = String(req.params.id);
  const role = db.prepare(`SELECT role FROM team_members WHERE team_id = ? AND user_id = ?`).get(teamId, req.session.user_id);
  if (!role || role.role !== "captain") return res.status(403).json({ error: "Только капитан" });

  const dataUrl = req.body?.dataUrl || req.body?.dataURL || null;
  if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ error: "Missing dataURL" });
  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!m) return res.status(400).json({ error: "Only PNG/JPG/WEBP" });

  const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  const buf = Buffer.from(m[2], "base64");
  const dir = path.join(process.cwd(), "public", "uploads", "avatars");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `team_${teamId}.${ext}`), buf);

  const url = `/uploads/avatars/team_${teamId}.${ext}?v=${Date.now()}`;
  db.prepare(`UPDATE teams SET avatar_url = ? WHERE id = ?`).run(url, teamId);
  res.json({ ok: true, avatarUrl: url });
});

