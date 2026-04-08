
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

process.env.TZ = "Europe/Moscow";

initSchema();

const MOSCOW_TZ = "Europe/Moscow";
const MOSCOW_OFFSET = "+03:00";

function parseMoscowInput(value) {
  const raw = (value ?? "").toString().trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return new Date(`${raw}:00${MOSCOW_OFFSET}`).toISOString();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

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

db.exec(`CREATE TABLE IF NOT EXISTS email_code_request_limits (
  id TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_email_code_request_limits_ip_created ON email_code_request_limits(ip, created_at)`);

function checkEmailCodeRateLimit(ip, email, purpose='register') {
  const cleanIp = String(ip||'unknown');
  const cleanEmail = String(email||'').trim().toLowerCase();
  const hourAgo = new Date(Date.now()-3600_000).toISOString();
  db.prepare(`DELETE FROM email_code_request_limits WHERE created_at < ?`).run(hourAgo);
  const rows = db.prepare(`SELECT created_at FROM email_code_request_limits WHERE ip = ? AND purpose = ? ORDER BY created_at DESC`).all(cleanIp, purpose);
  if (rows.length >= 5 && new Date(rows[4].created_at).getTime() > Date.now()-3600_000) {
    return { ok:false, error:'Слишком много запросов кода. Попробуйте через 1 час' };
  }
  if (rows[0] && new Date(rows[0].created_at).getTime() > Date.now()-120_000) {
    return { ok:false, error:'Повторно отправить код можно через 2 минуты' };
  }
  db.prepare(`INSERT INTO email_code_request_limits (id, ip, email, purpose, created_at) VALUES (?, ?, ?, ?, ?)`).run(nanoid(10), cleanIp, cleanEmail, purpose, nowIso());
  return { ok:true };
}

const MAIL_PROVIDER = String(process.env.MAIL_PROVIDER || "mailgun").trim().toLowerCase();
const MAIL_FROM = process.env.MAIL_FROM || "aftermatch.ru <no-reply@aftermatch.ru>";
const MAILGUN_API_KEY = String(process.env.MAILGUN_API_KEY || "").trim();
const MAILGUN_DOMAIN = String(process.env.MAILGUN_DOMAIN || "").trim();
const MAILGUN_BASE_URL = String(process.env.MAILGUN_BASE_URL || "https://api.mailgun.net").trim().replace(/\/$/, "");

async function sendMailSafe({ to, subject, text, html }) {
  if (MAIL_PROVIDER !== 'mailgun') {
    console.log(`[mail:skip] ${subject} -> ${to} (MAIL_PROVIDER=${MAIL_PROVIDER || 'empty'})`);
    return { ok: false, skipped: true, error: 'Почтовый провайдер не поддерживается. Установи MAIL_PROVIDER=mailgun' };
  }
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    console.log(`[mail:skip] ${subject} -> ${to} (MAILGUN_API_KEY / MAILGUN_DOMAIN not configured)`);
    return { ok: false, skipped: true, error: 'Mailgun на сервере не настроен' };
  }

  try {
    const body = new URLSearchParams();
    body.set('from', MAIL_FROM);
    body.set('to', to);
    body.set('subject', subject);
    if (text) body.set('text', text);
    if (html) body.set('html', html);

    const auth = Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');
    const response = await fetch(`${MAILGUN_BASE_URL}/v3/${MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
    });
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}

    if (!response.ok) {
      let detail = parsed?.message || raw || `HTTP ${response.status}`;
      if (response.status === 403) {
        detail = 'Mailgun отклонил отправку. Проверь verified domain, регион API и authorized recipients для sandbox';
      }
      console.error(`[mail:error] ${subject} -> ${to}`, detail);
      return { ok: false, error: detail };
    }

    const messageId = parsed?.id || null;
    console.log(`[mail:sent] ${subject} -> ${to} (${messageId || 'mailgun'})`);
    return { ok: true, messageId };
  } catch (err) {
    console.error(`[mail:error] ${subject} -> ${to}`, err?.message || err);
    return { ok: false, error: err?.message || 'Не удалось отправить письмо' };
  }
}

function randomCode(len = 6) {
  let out = ""; for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 10); return out;
}

function issueEmailCode(email, purpose, payload = null, ttlMinutes = 15) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const code = randomCode(6);
  const id = nanoid(10);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare(`INSERT INTO email_codes (id, email, purpose, code, payload_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, cleanEmail, purpose, code, payload ? JSON.stringify(payload) : null, expiresAt, nowIso());
  return { id, code, expiresAt };
}

function consumeEmailCode(email, purpose, code) {
  const row = db.prepare(`SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND code = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .get(String(email || "").trim().toLowerCase(), purpose, String(code || "").trim());
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  db.prepare(`UPDATE email_codes SET used_at = ? WHERE id = ?`).run(nowIso(), row.id);
  return { ...row, payload: row.payload_json ? JSON.parse(row.payload_json) : null };
}

function maybeIntroSeen(userId) {
  if (!userId) return;
  db.prepare(`UPDATE users SET intro_seen_at = COALESCE(intro_seen_at, ?) WHERE id = ?`).run(nowIso(), userId);
}

function hasColumn(table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((r) => String(r.name) === String(column));
  } catch {
    return false;
  }
}

const HAS_USER_EMAIL = hasColumn("users", "email");
const HAS_USER_BANNED_UNTIL = hasColumn("users", "banned_until");
const HAS_USER_BAN_REASON = hasColumn("users", "ban_reason");

function userEmailSupported() {
  try { return hasColumn('users', 'email'); } catch { return false; }
}

function safeUsersGetByLoginOrEmail(value) {
  try {
    if (userEmailSupported()) {
      return db.prepare(`SELECT * FROM users WHERE lower(nickname) = ? OR lower(email) = ?`).get(value, value);
    }
  } catch {}
  return db.prepare(`SELECT * FROM users WHERE lower(nickname) = ?`).get(value);
}

function getLoginByValue(login) {
  const value = String(login || "").trim().toLowerCase();
  if (!value) return null;
  return safeUsersGetByLoginOrEmail(value);
}

const app = express();
console.log('[boot] server starting');
app.use(express.json({ limit: '24mb' }));
app.use(express.urlencoded({ extended: true }));
// API_LOG
app.use((req,res,next)=>{
  if (req.url.startsWith('/api/teams') || req.url.startsWith('/api/team') || req.url.startsWith('/api/notifications')) {
    console.log('[api]', req.method, req.url);
  }
  next();
});
app.use(cors());
app.use(bodyParser.json({ limit: '24mb' }));
app.use(cookieParser());
app.use("/mappics", express.static(path.join(process.cwd(), "mappics")));
// Guard admin page: only logged-in admin can open /admin.html
app.use((req, res, next) => {
  if (req.path === "/admin.html" || req.path === "/tournament-settings.html") {
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
const STEAM_REGISTER_COOKIE = "steam_register_token";
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
function setSteamRegisterCookie(res, token) { res.cookie(STEAM_REGISTER_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 2*60*60*1000 }); }
function clearSteamRegisterCookie(res) { res.clearCookie(STEAM_REGISTER_COOKIE, { path: "/" }); }
function createPendingSteamLink({ steamId64, steamProfileName = null, steamAvatarUrl = null }) { const token = nanoid(24); db.prepare(`INSERT INTO pending_steam_links (token, steam_id64, steam_profile_name, steam_avatar_url, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)` ).run(token, steamId64, steamProfileName, steamAvatarUrl, nowIso(), addHoursIso(2)); return token; }
function getPendingSteamLink(token) { if (!token) return null; const row = db.prepare(`SELECT * FROM pending_steam_links WHERE token = ?`).get(String(token)); if (!row) return null; if (new Date(row.expires_at).getTime() < Date.now()) { try { db.prepare(`DELETE FROM pending_steam_links WHERE token = ?`).run(String(token)); } catch {} return null; } return row; }
function consumePendingSteamLink(token) { const row = getPendingSteamLink(token); if (!row) return null; try { db.prepare(`DELETE FROM pending_steam_links WHERE token = ?`).run(String(token)); } catch {} return row; }

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
  return db.prepare(`SELECT u.id, u.nickname, u.email, u.first_name, u.last_name, u.middle_name, u.steam_id64, u.steam_profile_name, u.avatar_url, u.profile_banner_url, u.role, u.created_at,
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
  res.cookie("steam_mode", String(req.query.mode || "register"), { sameSite: "lax", path: "/", maxAge: 10 * 60 * 1000 });
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
      return res.redirect(`/auth.html?mode=register&err=steam_failed`);
    }

    const m = String(result.claimedIdentifier).match(/\/id\/(\d+)\/?$/);
    const steamId64 = m ? m[1] : null;
    if (!steamId64) return res.redirect(`/auth.html?mode=register&err=steam_failed`);

    const steamMode = String(req.cookies?.steam_mode || "register");
    const persona = await fetchSteamPersonaName(steamId64);
    const avatarUrl = await fetchSteamAvatarUrl(steamId64);
    const existing = db.prepare(`SELECT id FROM users WHERE steam_id64 = ?`).get(steamId64);
    if (existing?.id) {
      if (steamMode === "register") return res.redirect(`/auth.html?mode=register&err=steam_already_linked`);
      try {
        db.prepare(`UPDATE users SET steam_profile_name = COALESCE(?, steam_profile_name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?`)
          .run(persona || null, avatarUrl || null, existing.id);
      } catch {}
      const sessionId = createSession({ userId: existing.id });
      setSessionCookie(res, sessionId);
      clearSteamRegisterCookie(res);
      maybeIntroSeen(existing.id);
      return res.redirect(`/tournaments.html`);
    }

    let sessionId = req.cookies?.[SESSION_COOKIE];
    const session = getSession(sessionId);
    if (!session) {
      sessionId = createSession({ pendingSteamId64: steamId64, pendingSteamProfileName: persona });
      setSessionCookie(res, sessionId);
    } else {
      db.prepare(`UPDATE sessions SET pending_steam_id64 = ?, pending_steam_profile_name = ?, expires_at = ? WHERE id = ?`)
        .run(steamId64, persona, addHoursIso(SESSION_TTL_HOURS), sessionId);
    }
    const token = createPendingSteamLink({ steamId64, steamProfileName: persona, steamAvatarUrl: avatarUrl });
    setSteamRegisterCookie(res, token);

    return res.redirect(`/auth.html?mode=register&steam=linked`);
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

function createVetoState(bo, mapPool, readyTimeoutSeconds = 60) {
  return {
    bo,
    steps: buildStepsForBo(bo),
    stepIndex: 0,
    remaining: [...mapPool],
    actions: [],
    picks: { A: [], B: [] },
    decider: null,
    ready: { A: false, B: false },
    ready_deadline_at: new Date(Date.now() + Math.max(15, Number(readyTimeoutSeconds || 60)) * 1000).toISOString(),
    current_turn: null,
    turn_deadline_at: null
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
  return db.prepare(`
    SELECT t.*, tm.role AS my_role
    FROM team_members tm
    JOIN teams t ON t.id = tm.team_id
    WHERE tm.user_id = ?
    LIMIT 1
  `).get(userId) || null;
}

function getTournamentTeams(tournamentId) {
  return db.prepare(`
    SELECT t.id, t.name, t.tag, t.description, t.avatar_url, tr.created_at AS registered_at,
           tr.confirmed_at, tr.disqualified_at, tr.disqualification_reason,
           (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS players_count
    FROM tournament_registrations tr
    JOIN teams t ON t.id = tr.team_id
    WHERE tr.tournament_id = ?
    ORDER BY CASE WHEN tr.disqualified_at IS NULL THEN 0 ELSE 1 END, tr.created_at ASC
  `).all(tournamentId);
}


function hydrateBracketMatch(row) {
  if (!row) return null;
  const teamA = row.team_a_id ? getTeam(row.team_a_id) : null;
  const teamB = row.team_b_id ? getTeam(row.team_b_id) : null;
  const winner = row.winner_team_id ? getTeam(row.winner_team_id) : null;
  const matchRow = row.match_id ? getMatch(row.match_id) : null;
  const activeMatch = matchRow ? hydrateMatch(matchRow) : null;
  const currentStatus = activeMatch?.status || row.status || null;
  return { ...row, teamA, teamB, winner, bo: Number(row.bo || matchRow?.bo || 0) || null, current_status: currentStatus };
}

function getBracketMatches(tournamentId) {
  const rows = db.prepare(`SELECT * FROM bracket_matches WHERE tournament_id = ? ORDER BY round_number ASC, slot_number ASC`).all(tournamentId);
  return rows.map(hydrateBracketMatch);
}


function generateSingleVisualBracket(size) {
  const rounds = Math.log2(size);
  const cols = [];
  for (let round = 1; round <= rounds; round++) {
    const matches = [];
    const count = size / (2 ** round);
    for (let slot = 1; slot <= count; slot++) {
      matches.push({ id: `WB-${round}-${slot}`, round, slot, teamA: "", teamB: "", scoreA: "", scoreB: "", winner: "" });
    }
    cols.push({ key: `R${round}`, title: round === rounds ? "Финал" : `Раунд ${round}`, matches });
  }
  return { type: "single", size, columns: cols };
}

function generateDoubleVisualBracket(size) {
  const rounds = Math.log2(size);
  const winnerCols = [];
  for (let round = 1; round <= rounds; round++) {
    const count = size / (2 ** round);
    const matches = [];
    for (let slot = 1; slot <= count; slot++) {
      matches.push({ id: `WB-${round}-${slot}`, round, slot, teamA: "", teamB: "", scoreA: "", scoreB: "", winner: "" });
    }
    winnerCols.push({ key: `WB${round}`, title: round === rounds ? "Финал верхней" : `Верхняя ${round}`, matches });
  }

  const loserCols = [];
  let loserRound = 1;
  for (let round = 1; round < rounds; round++) {
    const count = size / (2 ** (round + 1));
    for (let phase = 1; phase <= 2; phase++) {
      const matches = [];
      for (let slot = 1; slot <= count; slot++) {
        matches.push({ id: `LB-${loserRound}-${slot}`, round: loserRound, slot, teamA: "", teamB: "", scoreA: "", scoreB: "", winner: "" });
      }
      loserCols.push({ key: `LB${loserRound}`, title: `Нижняя ${loserRound}`, matches });
      loserRound += 1;
    }
  }

  const grandFinal = [{ key: "GF", title: "Гранд-финал", matches: [{ id: "GF-1", round: 1, slot: 1, teamA: "", teamB: "", scoreA: "", scoreB: "", winner: "" }] }];

  return {
    type: "double",
    size,
    sections: [
      { key: "winner", title: "Верхняя сетка", columns: winnerCols },
      { key: "loser", title: "Нижняя сетка", columns: loserCols },
      { key: "grand", title: "Финал", columns: grandFinal }
    ]
  };
}

function generateVisualBracket(type, size) {
  return type === "double" ? generateDoubleVisualBracket(size) : generateSingleVisualBracket(size);
}

function canViewPublicBracket(tournament, userId) {
  if (Number(tournament.bracket_public || 0) === 1) return true;
  if (!userId) return false;
  return !!db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'admin'`).get(userId);
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
    bracket_public: Number(t.bracket_public || 0),
    visual_bracket_type: t.visual_bracket_type || "single",
    visual_bracket_size: Number(t.visual_bracket_size || 0),
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
  return { ...match, tournament: t, teamA, teamB, server: serverRow, veto, result, bo: Number(match.bo || 0) || null, server_ip: match.server_ip || null, server_password: match.server_password || null, scheduled_at: match.scheduled_at || null };
}

function saveMatchVeto(matchId, veto) {
  db.prepare(`UPDATE matches SET veto_state_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(veto), nowIso(), matchId);
}


function getTournamentMaps(tournamentId) {
  const t = getTournament(tournamentId);
  if (!t) return [];
  try { return JSON.parse(t.map_pool_json || "[]"); } catch { return []; }
}

function syncMatchFromBracket(bracketId) {
  const row = db.prepare(`SELECT * FROM bracket_matches WHERE id = ?`).get(bracketId);
  if (!row || !row.team_a_id || !row.team_b_id) return null;

  let match = row.match_id ? db.prepare(`SELECT * FROM matches WHERE id = ?`).get(row.match_id) : null;
  const now = nowIso();
  if (!match) {
    const matchId = nanoid(10);
    db.prepare(`
      INSERT INTO matches (
        id, tournament_id, team_a_id, team_b_id, status,
        veto_state_json, result_json, created_at, updated_at,
        bracket_match_id, scheduled_at, server_ip, server_password, bo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      matchId, row.tournament_id, row.team_a_id, row.team_b_id, "scheduled",
      null, null, now, now,
      row.id, row.scheduled_at || null, row.server_ip || null, row.server_password || null, Number(row.bo || getTournament(row.tournament_id)?.bo || 1)
    );
    db.prepare(`UPDATE bracket_matches SET match_id = ?, updated_at = ? WHERE id = ?`).run(matchId, now, row.id);
    match = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(matchId);
  } else {
    db.prepare(`
      UPDATE matches
      SET team_a_id = ?, team_b_id = ?, scheduled_at = ?, server_ip = ?, server_password = ?, bo = ?, updated_at = ?
      WHERE id = ?
    `).run(row.team_a_id, row.team_b_id, row.scheduled_at || null, row.server_ip || null, row.server_password || null, Number(row.bo || getTournament(row.tournament_id)?.bo || 1), now, match.id);
    match = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(match.id);
  }
  return match;
}

function randomSide() { return Math.random() < 0.5 ? "A" : "B"; }

function applyVetoTimeoutIfNeeded(matchId) {
  const m = getMatch(matchId);
  if (!m || !m.veto_state_json) return false;
  let veto = null;
  try { veto = JSON.parse(m.veto_state_json); } catch { return false; }
  if (!veto || !veto.turn_deadline_at || !veto.current_turn) return false;
  if (new Date(veto.turn_deadline_at).getTime() > Date.now()) return false;

  const step = veto.steps[veto.stepIndex];
  if (!step) return false;
  if (!Array.isArray(veto.remaining) || !veto.remaining.length) return false;

  const pool = [...veto.remaining];
  const randomMap = pool[Math.floor(Math.random() * pool.length)];
  const type = step.type === "pick" ? "pick" : "ban";

  veto.actions.push({ type: type === "pick" ? "auto_pick" : "auto_ban", by: step.by, map: randomMap, at: nowIso() });
  veto.remaining = veto.remaining.filter(m => m !== randomMap);
  if (type === "pick") veto.picks[step.by].push(randomMap);
  veto.stepIndex += 1;

  const nextStep = veto.steps[veto.stepIndex];
  if (finalizeMapsIfPossible(veto)) {
    db.prepare(`UPDATE matches SET status = ?, updated_at = ? WHERE id = ?`).run("ready", nowIso(), matchId);
    veto.current_turn = null;
    veto.turn_deadline_at = null;
  } else if (nextStep) {
    veto.current_turn = nextStep.by;
    veto.turn_deadline_at = new Date(Date.now() + 30_000).toISOString();
  }

  saveMatchVeto(matchId, veto);
  return true;
}

function ensureVeto(matchId) {
  const m = getMatch(matchId);
  if (!m) return null;
  const t = getTournament(m.tournament_id);
  if (!t) return null;

  let veto = m.veto_state_json ? JSON.parse(m.veto_state_json) : null;
  if (!veto) {
    const mapPool = getTournamentMaps(t.id);
    const bo = Number(m.bo || t.bo || 1) || 1;
    veto = createVetoState(bo, mapPool, t.ready_confirm_timeout_seconds || 60);
    saveMatchVeto(matchId, veto);
    db.prepare(`UPDATE matches SET status = ?, updated_at = ? WHERE id = ?`)
      .run("awaiting_ready", nowIso(), matchId);
  } else {
    applyReadyTimeoutIfNeeded(matchId);
    applyVetoTimeoutIfNeeded(matchId);
    const mm = getMatch(matchId);
    veto = mm?.veto_state_json ? JSON.parse(mm.veto_state_json) : veto;
  }
  return veto;
}

function finalizeReadyStart(veto) {
  if (!veto?.ready?.A || !veto?.ready?.B) return false;
  const first = veto.steps[veto.stepIndex];
  veto.ready_deadline_at = null;
  veto.current_turn = first ? first.by : null;
  veto.turn_deadline_at = first ? new Date(Date.now() + 30_000).toISOString() : null;
  return true;
}

function setMatchAutoResult(matchId, winnerSide, reason) {
  const match = getMatch(matchId);
  if (!match) return false;
  const result = winnerSide ? { winner: winnerSide, reason, auto: true, scoreA: winnerSide === "A" ? 1 : 0, scoreB: winnerSide === "B" ? 1 : 0 } : { winner: null, reason, auto: true, scoreA: 0, scoreB: 0 };
  db.prepare(`UPDATE matches SET status = ?, result_json = ?, updated_at = ? WHERE id = ?`).run("finished", JSON.stringify(result), nowIso(), matchId);
  return true;
}

function applyReadyTimeoutIfNeeded(matchId) {
  const m = getMatch(matchId);
  if (!m || !m.veto_state_json) return false;
  let veto = null;
  try { veto = JSON.parse(m.veto_state_json); } catch { return false; }
  if (!veto || (veto.ready?.A && veto.ready?.B) || !veto.ready_deadline_at) return false;
  if (new Date(veto.ready_deadline_at).getTime() > Date.now()) return false;

  const aReady = !!veto.ready?.A;
  const bReady = !!veto.ready?.B;
  if (aReady && !bReady) setMatchAutoResult(matchId, "A", "Команда B не подтвердила готовность");
  else if (!aReady && bReady) setMatchAutoResult(matchId, "B", "Команда A не подтвердила готовность");
  else setMatchAutoResult(matchId, null, "Обе команды не подтвердили готовность");
  veto.current_turn = null;
  veto.turn_deadline_at = null;
  saveMatchVeto(matchId, veto);
  return true;
}

function tournamentRegistrationIsClosed(tournament) {
  if (!tournament) return true;
  if (Number(tournament.registration_closed || 0) === 1) return true;
  if (tournament.registration_until && new Date(tournament.registration_until).getTime() <= Date.now()) return true;
  return false;
}

function isTournamentCheckinOpen(tournament) {
  if (!tournament) return false;
  if (Number(tournament.early_checkin_open || 0) === 1) return true;
  if (!tournament.checkin_from) return false;
  return new Date(tournament.checkin_from).getTime() <= Date.now();
}

function isTournamentCheckinClosed(tournament) {
  if (!tournament?.checkin_until) return false;
  return new Date(tournament.checkin_until).getTime() <= Date.now();
}

function applyTournamentCheckinTimeouts(tournamentId) {
  const tournament = getTournament(tournamentId);
  if (!tournament || !isTournamentCheckinClosed(tournament)) return false;
  db.prepare(`
    UPDATE tournament_registrations
    SET disqualified_at = COALESCE(disqualified_at, ?),
        disqualification_reason = COALESCE(disqualification_reason, 'Чек-ин не подтверждён вовремя')
    WHERE tournament_id = ?
      AND confirmed_at IS NULL
      AND disqualified_at IS NULL
  `).run(nowIso(), tournamentId);
  return true;
}

function canUserOpenMatchRoom(matchId, userId) {
  const match = getMatch(matchId);
  if (!match || !userId) return false;
  const admin = db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'admin'`).get(userId);
  if (admin) return true;
  const member = db.prepare(`
    SELECT 1
    FROM team_members
    WHERE user_id = ? AND team_id IN (?, ?)
    LIMIT 1
  `).get(userId, match.team_a_id, match.team_b_id);
  if (!member) return false;
  if (!match.scheduled_at) return true;
  return new Date(match.scheduled_at).getTime() <= Date.now() + (30 * 60 * 1000);
}


function publicMatchState(matchId) {
  applyReadyTimeoutIfNeeded(matchId);
  applyVetoTimeoutIfNeeded(matchId);
  const m = hydrateMatch(getMatch(matchId));
  if (!m) return null;

  let connect = null;
  if (m.server_ip && m.server_password) connect = `connect ${m.server_ip}; password ${m.server_password}`;
  else if (m.server_ip) connect = `connect ${m.server_ip}`;
  else if (m.server && m.connect_password) connect = `connect ${m.server.ip}:${m.server.port}; password ${m.connect_password}`;
  else if (m.server) connect = `connect ${m.server.ip}:${m.server.port}`;

  const maps = [];
  if (m.veto) {
    if (m.veto.bo === 1) { if (m.veto.decider) maps.push(m.veto.decider); }
    else { maps.push(...m.veto.picks.A, ...m.veto.picks.B); if (m.veto.decider) maps.push(m.veto.decider); }
  }

  return {
    id: m.id,
    status: m.status,
    tournament: { id: m.tournament.id, name: m.tournament.name, mode: m.tournament.mode, bo: Number(m.bo || m.tournament.bo || 1), mapPool: getTournamentMaps(m.tournament.id) },
    teamA: { id: m.teamA.id, name: m.teamA.name, tag: m.teamA.tag || "", avatar_url: m.teamA.avatar_url || null },
    teamB: { id: m.teamB.id, name: m.teamB.name, tag: m.teamB.tag || "", avatar_url: m.teamB.avatar_url || null },
    serverIp: m.server_ip || (m.server ? `${m.server.ip}:${m.server.port}` : null),
    serverPassword: m.server_password || m.connect_password || null,
    connect,
    veto: m.veto,
    maps,
    result: m.result,
    scheduledAt: m.scheduled_at || null
  };
}

/* ===== Auth API ===== */
app.get("/api/auth/me", (req, res) => {
  const s = getSession(req.cookies?.[SESSION_COOKIE]);
  const pendingTokenRow = getPendingSteamLink(req.cookies?.[STEAM_REGISTER_COOKIE]);
  if (!s || !s.user_id) {
    return res.json({
      user: null,
      pendingSteamId64: s?.pending_steam_id64 || pendingTokenRow?.steam_id64 || null,
      pendingSteamProfileName: s?.pending_steam_profile_name || pendingTokenRow?.steam_profile_name || null
    });
  }
  const user = getUserSafeById(s.user_id);
  res.json({
    user,
    pendingSteamId64: s.pending_steam_id64 || pendingTokenRow?.steam_id64 || null,
    pendingSteamProfileName: s.pending_steam_profile_name || pendingTokenRow?.steam_profile_name || null
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
  const pendingSteam = (s && s.pending_steam_id64)
    ? { steam_id64: s.pending_steam_id64, steam_profile_name: s.pending_steam_profile_name || null, steam_avatar_url: null, fromSession: true }
    : consumePendingSteamLink(req.cookies?.[STEAM_REGISTER_COOKIE]);
  if (!pendingSteam?.steam_id64) return res.status(400).json({ error: "Сначала привяжи Steam" });

  const { nickname, password, firstName, lastName, middleName, email, code } = req.body || {};
  if (!nickname || !password || !firstName || !lastName || !email || !code) return res.status(400).json({ error: "Заполни все поля и код из почты" });

  const emailRow = consumeEmailCode(email, "register", code);
  if (!emailRow) return res.status(400).json({ error: "Код подтверждения почты неверный или истёк" });

  const nickExists = db.prepare(`SELECT id FROM users WHERE lower(nickname) = lower(?)`).get(nickname);
  if (nickExists) return res.status(409).json({ error: "Логин уже занят" });
  if (HAS_USER_EMAIL) {
    const emailExists = db.prepare(`SELECT id FROM users WHERE lower(email) = lower(?)`).get(email);
    if (emailExists) return res.status(409).json({ error: "Почта уже занята" });
  }

  const steamExists = db.prepare(`SELECT id FROM users WHERE steam_id64 = ?`).get(pendingSteam.steam_id64);
  if (steamExists) return res.status(409).json({ error: "Этот Steam уже привязан к аккаунту" });

  const userId = nanoid(10);
  const hash = await bcrypt.hash(password, 10);

  if (HAS_USER_EMAIL) {
    db.prepare(`INSERT INTO users (id, nickname, email, email_verified_at, password_hash, first_name, last_name, middle_name, steam_id64, steam_profile_name, role, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'player', ?)`)
      .run(userId, nickname, String(email).trim().toLowerCase(), nowIso(), hash, firstName, lastName, (middleName || null), pendingSteam.steam_id64, pendingSteam.steam_profile_name, nowIso());
  } else {
    db.prepare(`INSERT INTO users (id, nickname, password_hash, first_name, last_name, middle_name, steam_id64, steam_profile_name, role, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'player', ?)`)
      .run(userId, nickname, hash, firstName, lastName, (middleName || null), pendingSteam.steam_id64, pendingSteam.steam_profile_name, nowIso());
  }

  if (s?.id) {
    db.prepare(`UPDATE sessions SET user_id = ?, pending_steam_id64 = NULL, pending_steam_profile_name = NULL, expires_at = ? WHERE id = ?`)
      .run(userId, addHoursIso(SESSION_TTL_HOURS), s.id);
  } else {
    const newSessionId = createSession({ userId });
    setSessionCookie(res, newSessionId);
  }
  clearSteamRegisterCookie(res);
  const freshAvatar = pendingSteam.steam_avatar_url || await fetchSteamAvatarUrl(pendingSteam.steam_id64);
  if (freshAvatar) { try { db.prepare(`UPDATE users SET avatar_url = ? WHERE id = ?`).run(freshAvatar, userId); } catch {} }
  maybeIntroSeen(userId);

  res.json({ ok: true, user: getUserSafeById(userId) });
});

app.post("/api/auth/login", async (req, res) => {
  const { login, nickname, password } = req.body || {};
  const loginValue = login || nickname;
  if (!loginValue || !password) return res.status(400).json({ error: "Укажи почту/логин и пароль" });

  const row = getLoginByValue(loginValue);
  if (!row) return res.status(401).json({ error: "Неверный логин или пароль" });
  if (HAS_USER_BANNED_UNTIL && row.banned_until && row.banned_until > nowIso()) {
    return res.status(403).json({ error: `Аккаунт заблокирован до ${row.banned_until}${HAS_USER_BAN_REASON && row.ban_reason ? ` • ${row.ban_reason}` : ""}` });
  }

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: "Неверный логин или пароль" });

  const sessionId = createSession({ userId: row.id });
  setSessionCookie(res, sessionId);
  maybeIntroSeen(row.id);
  res.json({ ok: true, user: getUserSafeById(row.id) });
});

app.post("/api/auth/logout", (req, res) => {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/intro-state", (req, res) => {
  const sid = getSession(req.cookies?.[SESSION_COOKIE]);
  const user = sid?.user_id ? db.prepare(`SELECT id, intro_seen_at FROM users WHERE id = ?`).get(sid.user_id) : null;
  res.json({ authenticated: !!user, introSeen: !!user?.intro_seen_at });
});

app.post("/api/auth/intro-seen", requireAuth, (req, res) => {
  maybeIntroSeen(req.session.user_id);
  res.json({ ok: true });
});

app.post("/api/auth/send-register-code", async (req, res) => {
  const cleanEmail = String(req.body?.email || "").trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) return res.status(400).json({ error: "Укажи корректную почту" });
  try { if (userEmailSupported() && db.prepare(`SELECT 1 FROM users WHERE lower(email) = lower(?)`).get(cleanEmail)) return res.status(409).json({ error: "Почта уже используется" }); } catch {}
  const rl = checkEmailCodeRateLimit(req.ip, cleanEmail, "register");
  if (!rl.ok) return res.status(429).json({ error: rl.error });
  const issued = issueEmailCode(cleanEmail, "register", null, 15);
  const result = await sendMailSafe({ to: cleanEmail, subject: "aftermatch.ru — код подтверждения", text: `Код подтверждения: ${issued.code}`, html: renderMailTemplate({ title: "Давайте подтвердим вашу почту", intro: "Мы отправили вам 6-ти значный код на указанную почту", codeLabel: "КОД ПОДТВЕРЖДЕНИЯ", code: issued.code, expiresText: "Код действует 15 минут. Если это были не вы, просто проигнорируйте письмо." }) });
  if (!result.ok) return res.status(500).json({ error: result.error || "Не удалось отправить письмо" });
  res.json({ ok: true });
});

app.post("/api/auth/request-password-reset", async (req, res) => {
  const cleanEmail = String(req.body?.email || "").trim().toLowerCase();
  let user = null;
  try {
    if (userEmailSupported()) user = db.prepare(`SELECT id FROM users WHERE lower(email) = lower(?)`).get(cleanEmail);
  } catch {}
  if (user) {
    const issued = issueEmailCode(cleanEmail, "reset_password", { userId: user.id }, 15);
    const result = await sendMailSafe({ to: cleanEmail, subject: "aftermatch.ru — сброс пароля", text: `Код сброса: ${issued.code}`, html: renderMailTemplate({ title: "Сброс пароля", intro: "Мы получили запрос на смену пароля. Используйте код ниже, чтобы задать новый пароль.", codeLabel: "КОД СБРОСА", code: issued.code, expiresText: "Код действует 15 минут. Если это были не вы, просто проигнорируйте письмо." }) });
    if (!result.ok) return res.status(500).json({ error: result.error || "Не удалось отправить письмо" });
  }
  res.json({ ok: true });
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { email, code, password } = req.body || {};
  if (!email || !code || !password) return res.status(400).json({ error: "Нужно указать почту, код и новый пароль" });
  const row = consumeEmailCode(email, "reset_password", code);
  if (!row?.payload?.userId) return res.status(400).json({ error: "Код неверный или истёк" });
  const hash = await bcrypt.hash(password, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, row.payload.userId);
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(row.payload.userId);
  res.json({ ok: true });
});

app.patch("/api/auth/nickname", requireAuth, (req, res) => {
  const clean = String(req.body?.nickname || "").trim();
  if (!clean) return res.status(400).json({ error: "Укажи новый ник" });
  const me = db.prepare(`SELECT nickname_changed_at FROM users WHERE id = ?`).get(req.session.user_id);
  if (me?.nickname_changed_at) {
    const next = new Date(new Date(me.nickname_changed_at).getTime() + 30 * 24 * 3600_000);
    if (next.getTime() > Date.now()) return res.status(409).json({ error: `Ник можно менять раз в месяц. Следующая смена после ${next.toLocaleDateString('ru-RU')}` });
  }
  const exists = db.prepare(`SELECT 1 FROM users WHERE lower(nickname) = lower(?) AND id != ?`).get(clean, req.session.user_id);
  if (exists) return res.status(409).json({ error: "Этот ник уже занят" });
  db.prepare(`UPDATE users SET nickname = ?, nickname_changed_at = ? WHERE id = ?`).run(clean, nowIso(), req.session.user_id);
  res.json({ ok: true, user: getUserSafeById(req.session.user_id) });
});

function orderedFriendPair(a, b) { return [a, b].sort(); }

app.get("/api/friends", requireAuth, (req, res) => {
  const userId = req.session.user_id;
  const friends = db.prepare(`SELECT CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END AS friend_id, f.created_at FROM friends f WHERE f.user_a_id = ? OR f.user_b_id = ? ORDER BY f.created_at DESC`).all(userId, userId, userId).map(row => ({ ...row, friend: getUserSafeById(row.friend_id) }));
  const requests = db.prepare(`SELECT fr.*, u.nickname, u.avatar_url FROM friend_requests fr JOIN users u ON u.id = fr.from_user_id WHERE fr.to_user_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`).all(userId);
  res.json({ friends, requests });
});

app.post("/api/friends/request", requireAuth, (req, res) => {
  const toUserId = String(req.body?.userId || "");
  const fromUserId = req.session.user_id;
  if (!toUserId || toUserId === fromUserId) return res.status(400).json({ error: "Некорректный пользователь" });
  const [a,b] = orderedFriendPair(fromUserId, toUserId);
  if (db.prepare(`SELECT 1 FROM friends WHERE user_a_id = ? AND user_b_id = ?`).get(a,b)) return res.status(409).json({ error: "Вы уже друзья" });
  const pending = db.prepare(`SELECT 1 FROM friend_requests WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)) AND status = 'pending'`).get(fromUserId,toUserId,toUserId,fromUserId);
  if (pending) return res.status(409).json({ error: "Заявка уже существует" });
  db.prepare(`INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)`).run(nanoid(10), fromUserId, toUserId, nowIso());
  res.json({ ok: true });
});

app.post("/api/friends/respond", requireAuth, (req, res) => {
  const row = db.prepare(`SELECT * FROM friend_requests WHERE id = ? AND to_user_id = ?`).get(String(req.body?.requestId || ""), req.session.user_id);
  if (!row || row.status !== 'pending') return res.status(404).json({ error: "Заявка не найдена" });
  const status = req.body?.action === 'accept' ? 'accepted' : 'declined';
  db.prepare(`UPDATE friend_requests SET status = ?, responded_at = ? WHERE id = ?`).run(status, nowIso(), row.id);
  if (status === 'accepted') {
    const [a,b] = orderedFriendPair(row.from_user_id, row.to_user_id);
    db.prepare(`INSERT OR IGNORE INTO friends (user_a_id, user_b_id, created_at) VALUES (?, ?, ?)`).run(a,b,nowIso());
    const existingChat = db.prepare(`SELECT c.id FROM chats c JOIN chat_members m1 ON m1.chat_id = c.id JOIN chat_members m2 ON m2.chat_id = c.id WHERE c.kind = 'dm' AND m1.user_id = ? AND m2.user_id = ? LIMIT 1`).get(a,b);
    if (!existingChat) {
      const chatId = nanoid(10);
      db.prepare(`INSERT INTO chats (id, kind, created_at) VALUES (?, 'dm', ?)`).run(chatId, nowIso());
      db.prepare(`INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`).run(chatId, a, nowIso());
      db.prepare(`INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`).run(chatId, b, nowIso());
    }
  }
  res.json({ ok: true });
});

app.post("/api/chats/direct/:userId", requireAuth, (req, res) => {
  const meId = req.session.user_id;
  const otherId = String(req.params.userId || "");
  if (!otherId || otherId === meId) return res.status(400).json({ error: "bad_user" });
  const [a,b] = [meId, otherId].sort();
  const areFriends = !!db.prepare(`SELECT 1 FROM friends WHERE user_a_id = ? AND user_b_id = ?`).get(a,b);
  if (!areFriends && !isUserAdmin(meId)) return res.status(403).json({ error: "Только друзья могут открыть чат" });
  let chat = db.prepare(`SELECT c.id FROM chats c JOIN chat_members m1 ON m1.chat_id = c.id JOIN chat_members m2 ON m2.chat_id = c.id WHERE c.kind = 'dm' AND m1.user_id = ? AND m2.user_id = ? LIMIT 1`).get(a,b);
  if (!chat) {
    const chatId = nanoid(10);
    db.prepare(`INSERT INTO chats (id, kind, created_at) VALUES (?, 'dm', ?)`).run(chatId, nowIso());
    db.prepare(`INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`).run(chatId, a, nowIso());
    db.prepare(`INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`).run(chatId, b, nowIso());
    chat = { id: chatId };
  }
  res.json({ ok: true, chatId: chat.id });
});

app.get("/api/chats", requireAuth, (req, res) => {
  const chats = db.prepare(`SELECT c.id, c.kind, c.created_at FROM chats c JOIN chat_members cm ON cm.chat_id = c.id WHERE cm.user_id = ? ORDER BY c.created_at DESC`).all(req.session.user_id).map(chat => ({
    ...chat,
    members: db.prepare(`SELECT u.id, u.nickname, u.avatar_url FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ?`).all(chat.id),
    lastMessage: db.prepare(`SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`).get(chat.id)
  }));
  res.json(chats);
});

app.get("/api/chats/:id/messages", requireAuth, (req, res) => {
  const chatId = String(req.params.id);
  const ok = db.prepare(`SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?`).get(chatId, req.session.user_id);
  if (!ok) return res.status(403).json({ error: "Нет доступа" });
  const rows = db.prepare(`SELECT m.*, u.nickname, u.avatar_url FROM chat_messages m JOIN users u ON u.id = m.sender_user_id WHERE m.chat_id = ? ORDER BY m.created_at ASC LIMIT 200`).all(chatId);
  res.json(rows);
});

app.post("/api/chats/:id/messages", requireAuth, (req, res) => {
  const chatId = String(req.params.id);
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Пустое сообщение" });
  const ok = db.prepare(`SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?`).get(chatId, req.session.user_id);
  if (!ok) return res.status(403).json({ error: "Нет доступа" });
  const id = nanoid(10);
  db.prepare(`INSERT INTO chat_messages (id, chat_id, sender_user_id, text, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, chatId, req.session.user_id, text, nowIso());
  res.json({ ok: true, message: db.prepare(`SELECT m.*, u.nickname, u.avatar_url FROM chat_messages m JOIN users u ON u.id = m.sender_user_id WHERE m.id = ?`).get(id) });
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
           (SELECT COUNT(*) FROM tournament_registrations tr WHERE tr.tournament_id = t.id AND tr.disqualified_at IS NULL) AS teams_count
    FROM tournaments t
    ORDER BY t.created_at DESC
  `).all();
  res.json(rows.map(hydrateTournament));
});

app.get("/api/tournaments/:id", (req, res) => {
  applyTournamentCheckinTimeouts(String(req.params.id));
  const row = db.prepare(`
    SELECT t.*,
           (SELECT COUNT(*) FROM tournament_registrations tr WHERE tr.tournament_id = t.id AND tr.disqualified_at IS NULL) AS teams_count
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
    const reg = myTeam ? db.prepare(`SELECT confirmed_at, disqualified_at, disqualification_reason FROM tournament_registrations WHERE tournament_id = ? AND team_id = ?`).get(t.id, myTeam.id) : null;
    t.my_team_registered = !!reg;
    t.checkin_confirmed = !!reg?.confirmed_at;
    t.my_team_disqualified = !!reg?.disqualified_at;
    t.my_team_disqualification_reason = reg?.disqualification_reason || null;
    t.is_admin = !!db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'admin'`).get(session.user_id);
  } else {
    t.my_team = null;
    t.i_am_captain = false;
    t.my_team_registered = false;
    t.checkin_confirmed = false;
    t.my_team_disqualified = false;
    t.my_team_disqualification_reason = null;
    t.is_admin = false;
  }
  t.registration_is_closed = tournamentRegistrationIsClosed(t);
  t.checkin_is_open = isTournamentCheckinOpen(t);
  t.checkin_is_closed = isTournamentCheckinClosed(t);

t.bracket_matches = getBracketMatches(t.id);
t.room_matches = [];
if (session?.user_id) {
  t.room_matches = t.bracket_matches
    .filter(m => m.match_id && canUserOpenMatchRoom(m.match_id, session.user_id))
    .map(m => ({
      bracketMatchId: m.id,
      matchId: m.match_id,
      round: m.round_number,
      slot: m.slot_number,
      scheduledAt: m.scheduled_at,
      teamA: m.teamA ? { id: m.teamA.id, name: m.teamA.name } : null,
      teamB: m.teamB ? { id: m.teamB.id, name: m.teamB.name } : null
    }));
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
    checkinUntil,
    matchesStartAt,
    maxTeams,
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
  const cleanCheckin = parseMoscowInput(checkinUntil);
  const cleanMatchesStart = parseMoscowInput(matchesStartAt);
  const cleanMaxTeams = Number(maxTeams || 0);
  const places = Number(prizePlaces || 0);

  if (!cleanName) return res.status(400).json({ error: "Название обязательно" });
  if (![0, 1, 3].includes(places)) return res.status(400).json({ error: "Призовые места: 0, 1 или 3" });
  if (places === 1 && !(prize1 ?? "").toString().trim()) return res.status(400).json({ error: "Укажи приз за 1 место" });
  if (places === 3 && (![prize1, prize2, prize3].every(v => (v ?? "").toString().trim()))) return res.status(400).json({ error: "Укажи призы для 1-3 мест" });

  const id = nanoid(10);
  const defaultMaps = ["de_mirage","de_inferno","de_nuke","de_ancient","de_anubis","de_vertigo","de_dust2"];

  db.prepare(`
    INSERT INTO tournaments (
      id, name, description, prize, cover_url, page_cover_url, mode, bracket_mode, bo, map_pool_json,
      checkin_until, matches_start_at, max_teams,
      prize_places, prize_1, prize_2, prize_3, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    cleanCheckin,
    cleanMatchesStart,
    cleanMaxTeams,
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

app.delete("/api/servers/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id || "");
  db.prepare(`UPDATE servers SET is_active = 0 WHERE id = ?`).run(id);
  res.json({ ok: true });
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

  socket.on("match:ready", ({ matchId }) => {
    if (!matchId) return;
    ensureVeto(matchId);
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

    const step = veto.steps[veto.stepIndex];
    if (!step) return;
    if (step.by !== side) return;
    if (step.type !== type) return;
    if (!veto.remaining.includes(map)) return;

    if (veto.current_turn !== side) return;
    veto.actions.push({ type, by: side, map, at: nowIso() });
    veto.remaining = veto.remaining.filter(m => m !== map);
    if (type === "pick") veto.picks[side].push(map);
    veto.stepIndex += 1;

    const done = finalizeMapsIfPossible(veto);
    if (done && veto.decider) {
      veto.current_turn = null;
      veto.turn_deadline_at = null;
      db.prepare(`UPDATE matches SET status = ?, updated_at = ? WHERE id = ?`)
        .run("ready", nowIso(), matchId);
    } else {
      const nextStep = veto.steps[veto.stepIndex];
      veto.current_turn = nextStep ? nextStep.by : null;
      veto.turn_deadline_at = nextStep ? new Date(Date.now() + 30_000).toISOString() : null;
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


app.get("/api/matches/:id/room", requireAuth, (req, res) => {
  const matchId = String(req.params.id);
  const userId = req.session.user_id;
  const rawMatch = getMatch(matchId);
  if (!rawMatch) return res.status(404).json({ error: "Матч не найден" });

  ensureVeto(matchId);
  const state = publicMatchState(matchId);
  if (!state) return res.status(404).json({ error: "Матч не найден" });

  const side = getUserSideForMatch(matchId, userId);
  const admin = !!db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'admin'`).get(userId);
  const participant = !!db.prepare(`SELECT 1 FROM team_members WHERE user_id = ? AND team_id IN (?, ?) LIMIT 1`).get(userId, rawMatch.team_a_id, rawMatch.team_b_id);
  const canOpen = canUserOpenMatchRoom(matchId, userId);
  const capA = db.prepare(`SELECT u.nickname FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? AND tm.role='captain'`).get(state.teamA.id);
  const capB = db.prepare(`SELECT u.nickname FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? AND tm.role='captain'`).get(state.teamB.id);

  res.json({
    ...state,
    mySide: side,
    isAdmin: admin,
    isParticipant: participant,
    canOpenRoom: canOpen,
    canInteract: !!side,
    showServer: admin || participant,
    captains: { A: capA?.nickname || null, B: capB?.nickname || null },
    readyTimeoutSeconds: Number(getTournament(state.tournament.id)?.ready_confirm_timeout_seconds || 60)
  });
});

app.post("/api/matches/:id/ready", requireAuth, (req, res) => {
  const matchId = String(req.params.id);
  const userId = req.session.user_id;
  const side = getUserSideForMatch(matchId, userId);
  if (!side) return res.status(403).json({ error: "Только капитаны могут подтвердить готовность" });

  const veto = ensureVeto(matchId);
  if (!veto) return res.status(404).json({ error: "Матч не найден" });
  if (getMatch(matchId)?.status === "finished") return res.status(409).json({ error: "Матч уже завершён" });

  veto.ready = veto.ready || { A: false, B: false };
  veto.ready[side] = true;
  veto.actions = veto.actions || [];
  veto.actions.push({ type: "ready", by: side, at: nowIso() });

  let status = "awaiting_ready";
  if (veto.ready.A && veto.ready.B) {
    finalizeReadyStart(veto);
    status = "veto";
  }

  saveMatchVeto(matchId, veto);
  db.prepare(`UPDATE matches SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), matchId);
  res.json({ ok: true, state: publicMatchState(matchId) });
});

app.post("/api/matches/:id/veto-action", requireAuth, (req, res) => {
  const matchId = String(req.params.id);
  const userId = req.session.user_id;
  const side = getUserSideForMatch(matchId, userId);
  if (!side) return res.status(403).json({ error: "Только капитаны могут участвовать в veto" });

  const { map } = req.body || {};
  if (!map) return res.status(400).json({ error: "Выбери карту" });

  const veto = ensureVeto(matchId);
  if (!veto) return res.status(404).json({ error: "Матч не найден" });
  if (!veto.ready?.A || !veto.ready?.B) return res.status(409).json({ error: "Обе команды должны подтвердить готовность" });

  if (veto.current_turn !== side) return res.status(409).json({ error: "Сейчас ход другой команды" });
  const step = veto.steps[veto.stepIndex];
  if (!step) return res.status(409).json({ error: "Veto уже завершен" });
  if (!veto.remaining.includes(map)) return res.status(400).json({ error: "Эта карта недоступна" });

  veto.actions.push({ type: step.type, by: side, map, at: nowIso() });
  veto.remaining = veto.remaining.filter(m => m !== map);
  if (step.type === "pick") veto.picks[side].push(map);
  veto.stepIndex += 1;

  if (finalizeMapsIfPossible(veto)) {
    veto.current_turn = null;
    veto.turn_deadline_at = null;
    db.prepare(`UPDATE matches SET status = ?, updated_at = ? WHERE id = ?`).run("ready", nowIso(), matchId);
  } else {
    const nextStep = veto.steps[veto.stepIndex];
    veto.current_turn = nextStep.by;
    veto.turn_deadline_at = new Date(Date.now() + 30_000).toISOString();
  }

  saveMatchVeto(matchId, veto);
  res.json({ ok: true, state: publicMatchState(matchId) });
});


app.get("/api/tournaments/:id/settings", requireAdmin, (req, res) => {
  const row = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(String(req.params.id));
  if (!row) return res.status(404).json({ error: "Tournament not found" });

  const teams = getTournamentTeams(row.id);
  const textBracket = getBracketMatches(row.id);
  let visualBracket = null;
  try {
    visualBracket = row.visual_bracket_json ? JSON.parse(row.visual_bracket_json) : null;
  } catch {
    visualBracket = null;
  }

  res.json({
    tournament: hydrateTournament(row),
    teams,
    textBracket,
    visualBracket
  });
});

app.patch("/api/tournaments/:id/settings", requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const row = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: "Tournament not found" });

  const body = req.body || {};
  const prizePlaces = Number(body.prize_places ?? row.prize_places ?? 0);

  db.prepare(`
    UPDATE tournaments
    SET
      name = ?,
      description = ?,
      cover_url = ?,
      page_cover_url = ?,
      prize = ?,
      prize_places = ?,
      prize_1 = ?,
      prize_2 = ?,
      prize_3 = ?,
      max_teams = ?,
      bo = ?,
      map_pool_json = ?,
      early_checkin_open = ?,
      registration_closed = ?,
      checkin_from = ?,
      checkin_until = ?,
      registration_until = ?,
      ready_confirm_timeout_seconds = ?,
      matches_start_at = ?,
      rules_text = ?
    WHERE id = ?
  `).run(
    (body.name ?? row.name ?? "").toString().trim(),
    (body.description ?? row.description ?? "").toString().trim() || null,
    (body.cover_url ?? row.cover_url ?? "").toString().trim() || null,
    (body.page_cover_url ?? row.page_cover_url ?? "").toString().trim() || null,
    prizePlaces > 0 ? "configured" : null,
    prizePlaces,
    (body.prize_1 ?? row.prize_1 ?? "").toString().trim() || null,
    (body.prize_2 ?? row.prize_2 ?? "").toString().trim() || null,
    (body.prize_3 ?? row.prize_3 ?? "").toString().trim() || null,
    Number(body.max_teams ?? row.max_teams ?? 0),
    [1,3].includes(Number(body.bo)) ? Number(body.bo) : Number(row.bo || 1),
    JSON.stringify(Array.isArray(body.map_pool) ? body.map_pool : String(body.map_pool ?? row.map_pool_json ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)),
    Number(body.early_checkin_open ?? row.early_checkin_open ?? 0) ? 1 : 0,
    Number(body.registration_closed ?? row.registration_closed ?? 0) ? 1 : 0,
    parseMoscowInput(body.checkin_from ?? row.checkin_from ?? null),
    parseMoscowInput(body.checkin_until ?? row.checkin_until ?? null),
    parseMoscowInput(body.registration_until ?? row.registration_until ?? null),
    Math.max(15, Number(body.ready_confirm_timeout_seconds ?? row.ready_confirm_timeout_seconds ?? 60) || 60),
    parseMoscowInput(body.matches_start_at ?? row.matches_start_at ?? null),
    (body.rules_text ?? row.rules_text ?? "").toString(),
    id
  );

  res.json({ ok: true });
});

app.post("/api/tournaments/:id/visual-bracket/generate", requireAdmin, (req, res) => {
  const tournamentId = String(req.params.id);
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId);
  if (!tournament) return res.status(404).json({ error: "Tournament not found" });

  const size = Number(req.body?.size || 0);
  const type = (req.body?.type || "single").toString();
  const isPublic = Number(req.body?.bracket_public || 0) ? 1 : 0;

  if (![2, 4, 8, 16, 32].includes(size)) {
    return res.status(400).json({ error: "Размер сетки: 2, 4, 8, 16, 32" });
  }
  if (!["single", "double"].includes(type)) {
    return res.status(400).json({ error: "Тип сетки: single/double" });
  }

  const visual = generateVisualBracket(type, size);

  db.prepare(`
    UPDATE tournaments
    SET visual_bracket_json = ?, visual_bracket_type = ?, visual_bracket_size = ?, bracket_public = ?
    WHERE id = ?
  `).run(JSON.stringify(visual), type, size, isPublic, tournamentId);

  res.json({ ok: true, visual });
});

app.post("/api/tournaments/:id/text-bracket/generate", requireAdmin, (req, res) => {
  const tournamentId = String(req.params.id);
  const teams = getTournamentTeams(tournamentId);
  const requestedSize = Number(req.body?.size || 0);

  if (![2, 4, 8, 16, 32].includes(requestedSize)) {
    return res.status(400).json({ error: "Размер сетки: 2, 4, 8, 16, 32" });
  }
  if (teams.length < 2) {
    return res.status(409).json({ error: "Нужно минимум 2 команды" });
  }
  if (teams.length > requestedSize) {
    return res.status(409).json({ error: "Команд больше, чем размер сетки" });
  }

  db.prepare(`DELETE FROM bracket_matches WHERE tournament_id = ?`).run(tournamentId);

  const size = requestedSize;
  const rounds = Math.log2(size);
  const idsByRoundSlot = {};
  const now = nowIso();

  for (let round = 1; round <= rounds; round++) {
    const matchesInRound = size / (2 ** round);
    for (let slot = 1; slot <= matchesInRound; slot++) {
      idsByRoundSlot[`${round}:${slot}`] = nanoid(10);
    }
  }

  for (let round = 1; round <= rounds; round++) {
    const matchesInRound = size / (2 ** round);
    for (let slot = 1; slot <= matchesInRound; slot++) {
      let teamAId = null;
      let teamBId = null;

      if (round === 1) {
        const i = (slot - 1) * 2;
        teamAId = teams[i]?.id || null;
        teamBId = teams[i + 1]?.id || null;
      }

      const nextMatchId = round < rounds ? idsByRoundSlot[`${round + 1}:${Math.ceil(slot / 2)}`] : null;
      const nextSlot = round < rounds ? (slot % 2 === 1 ? "A" : "B") : null;

      db.prepare(`
        INSERT INTO bracket_matches (
          id, tournament_id, round_number, slot_number,
          team_a_id, team_b_id, next_match_id, next_slot,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        idsByRoundSlot[`${round}:${slot}`],
        tournamentId,
        round,
        slot,
        teamAId,
        teamBId,
        nextMatchId,
        nextSlot,
        now,
        now
      );
    }
  }

  db.prepare(`UPDATE tournaments SET text_bracket_size = ? WHERE id = ?`).run(size, tournamentId);

  res.json({ ok: true });
});

app.get("/api/tournaments/:id/rules", (req, res) => {
  const row = db.prepare(`SELECT id, name, rules_text FROM tournaments WHERE id = ?`).get(String(req.params.id));
  if (!row) return res.status(404).json({ error: "Tournament not found" });
  res.json(row);
});

app.get("/api/tournaments/:id/visual-bracket", (req, res) => {
  const row = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(String(req.params.id));
  if (!row) return res.status(404).json({ error: "Tournament not found" });

  const session = getSession(req.cookies?.[SESSION_COOKIE]);
  const userId = session?.user_id || null;
  if (!canViewPublicBracket(row, userId)) {
    return res.status(403).json({ error: "Сетка пока скрыта" });
  }

  let bracket = null;
  try {
    bracket = row.visual_bracket_json ? JSON.parse(row.visual_bracket_json) : null;
  } catch {
    bracket = null;
  }

  res.json({
    tournamentId: row.id,
    name: row.name,
    type: row.visual_bracket_type || "single",
    size: Number(row.visual_bracket_size || 0),
    bracket_public: Number(row.bracket_public || 0),
    bracket
  });
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

  if (userId) {
    const roomMatches = db.prepare(`
      SELECT m.id, m.scheduled_at, t.name AS tournament_name,
             ta.name AS team_a_name, tb.name AS team_b_name
      FROM matches m
      JOIN tournaments t ON t.id = m.tournament_id
      JOIN teams ta ON ta.id = m.team_a_id
      JOIN teams tb ON tb.id = m.team_b_id
      WHERE m.scheduled_at IS NOT NULL
        AND datetime(m.scheduled_at) <= datetime(?)
        AND datetime(m.scheduled_at) >= datetime(?)
        AND EXISTS (
          SELECT 1 FROM team_members tm
          WHERE tm.user_id = ? AND tm.team_id IN (m.team_a_id, m.team_b_id)
        )
      ORDER BY m.scheduled_at ASC
      LIMIT 5
    `).all(new Date(Date.now() + 30 * 60 * 1000).toISOString(), nowIso(), userId);

    for (const m of roomMatches) {
      const startsSoon = new Date(m.scheduled_at).getTime() > Date.now();
      items.push({
        type: startsSoon ? "match_soon" : "match_room",
        id: m.id,
        title: startsSoon ? "Скоро матч" : "Комната матча",
        body: `${m.tournament_name} • ${m.team_a_name} vs ${m.team_b_name}`,
        href: `/match-room.html?id=${m.id}`
      });
    }
  }

  res.json({ items });
});

app.get("/api/ping", (req,res)=>res.json({ ok:true, ts: Date.now() }));

app.get("/api/version", (req,res)=>res.json({ version:"aftermatch-fix19" }));

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

function saveBase64Image(dataUrl, outBasePath) {
  const m = (dataUrl || "").match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
  if (!m) return { error: "Only PNG/JPG/WEBP" };
  const rawExt = m[1].toLowerCase();
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
  const outPath = outBasePath.replace(/\.[a-z0-9]+$/i, '') + '.' + ext;
  try {
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, Buffer.from(m[2], 'base64'));
    return { ok: true, ext, path: outPath };
  } catch {
    return { error: 'save_failed' };
  }
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
  const dir = path.join(process.cwd(), "public", "uploads", "avatars");
  const outBase = path.join(dir, `${req.session.user_id}.webp`);
  const saved = saveBase64Image(dataUrl, outBase);
  if (saved.error) return res.status(400).json({ error: saved.error });
  const url = `/uploads/avatars/${req.session.user_id}.${saved.ext}?v=${Date.now()}`;
  try { db.prepare(`UPDATE users SET avatar_url = ? WHERE id = ?`).run(url, req.session.user_id); } catch (e) {
    return res.status(500).json({ error: "avatar_update_failed" });
  }
  res.json({ ok: true, avatarUrl: url });
});

app.post("/api/me/banner", requireAuth, (req, res) => {
  const dataUrl = req.body?.dataUrl || req.body?.dataURL || null;
  if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ error: "Missing dataURL" });
  const dir = path.join(process.cwd(), "public", "uploads", "banners");
  const outBase = path.join(dir, `${req.session.user_id}.webp`);
  const saved = saveBase64Image(dataUrl, outBase);
  if (saved.error) return res.status(400).json({ error: saved.error });
  const url = `/uploads/banners/${req.session.user_id}.${saved.ext}?v=${Date.now()}`;
  try { db.prepare(`UPDATE users SET profile_banner_url = ? WHERE id = ?`).run(url, req.session.user_id); } catch (e) {
    return res.status(500).json({ error: "banner_update_failed" });
  }
  res.json({ ok: true, bannerUrl: url });
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

  if (tournamentRegistrationIsClosed(tournament)) {
    return res.status(409).json({ error: "Регистрация на турнир закрыта" });
  }

  const maxTeams = Number(tournament.max_teams || 0);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM tournament_registrations WHERE tournament_id = ? AND disqualified_at IS NULL`).get(tournamentId)?.c || 0;
  if (maxTeams > 0 && count >= maxTeams) return res.status(409).json({ error: "Достигнут лимит команд" });

  const exists = db.prepare(`SELECT 1 FROM tournament_registrations WHERE tournament_id = ? AND team_id = ?`).get(tournamentId, team.id);
  if (exists) return res.status(409).json({ error: "Команда уже участвует в турнире" });

  db.prepare(`INSERT INTO tournament_registrations (tournament_id, team_id, registered_by_user_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(tournamentId, team.id, userId, nowIso());

  res.json({ ok: true });
});

app.post("/api/tournaments/:id/register-player", requireAuth, (req, res) => {
  const tournamentId = String(req.params.id);
  const userId = req.session.user_id;
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId);
  if (!tournament) return res.status(404).json({ error: "Tournament not found" });
  if (String(tournament.mode || '').toLowerCase() !== '1v1') return res.status(409).json({ error: 'Одиночная регистрация доступна только для 1x1' });
  if (tournamentRegistrationIsClosed(tournament)) return res.status(409).json({ error: 'Регистрация на турнир закрыта' });
  const exists = db.prepare(`SELECT 1 FROM tournament_player_registrations WHERE tournament_id = ? AND user_id = ?`).get(tournamentId, userId);
  if (exists) return res.status(409).json({ error: 'Ты уже зарегистрирован на турнир' });
  db.prepare(`INSERT INTO tournament_player_registrations (tournament_id, user_id, created_at) VALUES (?, ?, ?)`).run(tournamentId, userId, nowIso());
  res.json({ ok: true });
});

app.post("/api/tournaments/:id/checkin", requireAuth, (req, res) => {
  const tournamentId = String(req.params.id);
  applyTournamentCheckinTimeouts(tournamentId);
  const tournament = getTournament(tournamentId);
  if (!tournament) return res.status(404).json({ error: "Tournament not found" });
  const team = getMyTeam(req.session.user_id);
  if (!team) return res.status(409).json({ error: "Сначала создай команду" });
  const captain = db.prepare(`SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND role = 'captain'`).get(team.id, req.session.user_id);
  if (!captain) return res.status(403).json({ error: "Только капитан может подтвердить участие" });
  const reg = db.prepare(`SELECT confirmed_at, disqualified_at FROM tournament_registrations WHERE tournament_id = ? AND team_id = ?`).get(tournamentId, team.id);
  if (!reg) return res.status(404).json({ error: "Команда не зарегистрирована на турнир" });
  if (reg.disqualified_at) return res.status(409).json({ error: "Команда уже дисквалифицирована" });
  if (isTournamentCheckinClosed(tournament)) return res.status(409).json({ error: "Чек-ин уже закрыт" });
  if (!isTournamentCheckinOpen(tournament)) return res.status(409).json({ error: "Чек-ин ещё не открыт" });
  db.prepare(`UPDATE tournament_registrations SET confirmed_at = COALESCE(confirmed_at, ?) WHERE tournament_id = ? AND team_id = ?`).run(nowIso(), tournamentId, team.id);
  res.json({ ok: true });
});

app.post("/api/tournaments/:id/remove-team", requireAdmin, (req, res) => {
  const tournamentId = String(req.params.id);
  const teamId = String(req.body?.teamId || "");
  if (!teamId) return res.status(400).json({ error: "teamId required" });

  db.prepare(`DELETE FROM tournament_registrations WHERE tournament_id = ? AND team_id = ?`).run(tournamentId, teamId);
  res.json({ ok: true });
});

app.patch("/api/teams/:id/identity", requireAuth, (req, res) => {
  const teamId = String(req.params.id);
  if (!isCaptainOfTeam(teamId, req.session.user_id)) return res.status(403).json({ error: "Только капитан может менять имя и тег" });
  const team = db.prepare(`SELECT identity_changed_at FROM teams WHERE id = ?`).get(teamId);
  if (!team) return res.status(404).json({ error: "Команда не найдена" });
  if (team.identity_changed_at) {
    const next = new Date(new Date(team.identity_changed_at).getTime() + 30 * 24 * 3600_000);
    if (next.getTime() > Date.now()) return res.status(409).json({ error: `Имя и тег можно менять раз в месяц. Следующая смена после ${next.toLocaleDateString('ru-RU')}` });
  }
  const name = String(req.body?.name || '').trim();
  const tag = String(req.body?.tag || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажи имя команды' });
  const exists = db.prepare(`SELECT 1 FROM teams WHERE lower(name) = lower(?) AND id != ?`).get(name, teamId);
  if (exists) return res.status(409).json({ error: 'Имя команды уже занято' });
  db.prepare(`UPDATE teams SET name = ?, tag = ?, identity_changed_at = ? WHERE id = ?`).run(name, tag || null, nowIso(), teamId);
  res.json({ ok: true, team: getTeam(teamId) });
});

app.patch("/api/teams/:id/members/:userId/role", requireAuth, (req, res) => {
  const teamId = String(req.params.id);
  const targetUserId = String(req.params.userId);
  if (!isCaptainOfTeam(teamId, req.session.user_id)) return res.status(403).json({ error: "Только капитан может менять роли" });
  const role = String(req.body?.role || '').trim();
  const allowed = new Set(['captain','main','substitute','coach']);
  if (!allowed.has(role)) return res.status(400).json({ error: 'Недопустимая роль' });
  const members = db.prepare(`SELECT user_id, role FROM team_members WHERE team_id = ?`).all(teamId);
  if (!members.find(m => m.user_id === targetUserId)) return res.status(404).json({ error: 'Игрок не найден в команде' });
  const counts = { main: 0, substitute: 0, coach: 0, captain: 0 };
  for (const m of members) counts[m.role] = (counts[m.role] || 0) + (m.user_id === targetUserId ? 0 : 1);
  counts[role] = (counts[role] || 0) + 1;
  if ((counts.main + counts.captain) > 5) return res.status(409).json({ error: 'Основных игроков может быть максимум 5' });
  if (counts.substitute > 2) return res.status(409).json({ error: 'Запасных может быть максимум 2' });
  if (counts.coach > 1) return res.status(409).json({ error: 'Тренер может быть только один' });
  if (role === 'captain') db.prepare(`UPDATE team_members SET role = 'main' WHERE team_id = ? AND role = 'captain'`).run(teamId);
  db.prepare(`UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?`).run(role, teamId, targetUserId);
  res.json({ ok: true, members: getTeamMembers(teamId) });
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


app.patch("/api/tournaments/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const row = db.prepare(`SELECT id FROM tournaments WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: "Tournament not found" });

  const body = req.body || {};
  const payload = {
    name: (body.name ?? "").toString().trim(),
    description: (body.description ?? "").toString().trim() || null,
    cover_url: (body.cover_url ?? "").toString().trim() || null,
    page_cover_url: (body.page_cover_url ?? "").toString().trim() || null,
    prize_places: Number(body.prize_places || 0),
    prize_1: (body.prize_1 ?? "").toString().trim() || null,
    prize_2: (body.prize_2 ?? "").toString().trim() || null,
    prize_3: (body.prize_3 ?? "").toString().trim() || null,
    max_teams: Number(body.max_teams || 0),
    early_checkin_open: body.early_checkin_open ? 1 : 0,
    registration_closed: body.registration_closed ? 1 : 0,
    checkin_until: (body.checkin_until ?? "").toString().trim() || null,
    matches_start_at: (body.matches_start_at ?? "").toString().trim() || null
  };
  if (!payload.name) return res.status(400).json({ error: "Название обязательно" });
  if (![0,1,3].includes(payload.prize_places)) return res.status(400).json({ error: "Призовые места: 0, 1 или 3" });

  db.prepare(`UPDATE tournaments
              SET name=?, description=?, cover_url=?, page_cover_url=?, prize=?, prize_places=?, prize_1=?, prize_2=?, prize_3=?,
                  max_teams=?, early_checkin_open=?, registration_closed=?, checkin_until=?, matches_start_at=?
              WHERE id=?`)
    .run(
      payload.name, payload.description, payload.cover_url, payload.page_cover_url,
      payload.prize_places > 0 ? "configured" : null,
      payload.prize_places, payload.prize_1, payload.prize_2, payload.prize_3,
      payload.max_teams, payload.early_checkin_open, payload.registration_closed, payload.checkin_until, payload.matches_start_at,
      id
    );

  res.json({ ok: true });
});

app.post("/api/tournaments/:id/bracket/generate", requireAdmin, (req, res) => {
  const tournamentId = String(req.params.id);
  const teams = getTournamentTeams(tournamentId);
  if (teams.length < 2) return res.status(409).json({ error: "Нужно минимум 2 команды" });

  db.prepare(`DELETE FROM bracket_matches WHERE tournament_id = ?`).run(tournamentId);

  let size = 1;
  while (size < teams.length) size *= 2;
  const rounds = Math.log2(size);
  const idsByRoundSlot = {};
  const now = nowIso();

  for (let round = 1; round <= rounds; round++) {
    const matchesInRound = size / (2 ** round);
    for (let slot = 1; slot <= matchesInRound; slot++) {
      const id = nanoid(10);
      idsByRoundSlot[`${round}:${slot}`] = id;
    }
  }

  for (let round = 1; round <= rounds; round++) {
    const matchesInRound = size / (2 ** round);
    for (let slot = 1; slot <= matchesInRound; slot++) {
      let teamAId = null;
      let teamBId = null;
      if (round === 1) {
        const i = (slot - 1) * 2;
        teamAId = teams[i]?.id || null;
        teamBId = teams[i+1]?.id || null;
      }
      const nextMatchId = round < rounds ? idsByRoundSlot[`${round+1}:${Math.ceil(slot/2)}`] : null;
      const nextSlot = round < rounds ? (slot % 2 === 1 ? "A" : "B") : null;
      db.prepare(`INSERT INTO bracket_matches (id, tournament_id, round_number, slot_number, team_a_id, team_b_id, next_match_id, next_slot, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(idsByRoundSlot[`${round}:${slot}`], tournamentId, round, slot, teamAId, teamBId, nextMatchId, nextSlot, now, now);
    }
  }

  res.json({ ok: true });
});

app.patch("/api/bracket-matches/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const body = req.body || {};
  const row = db.prepare(`SELECT * FROM bracket_matches WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: "Match not found" });

  const teamAId = (body.team_a_id ?? row.team_a_id ?? null) || null;
  const teamBId = (body.team_b_id ?? row.team_b_id ?? null) || null;
  const scheduledAt = parseMoscowInput(body.scheduled_at ?? row.scheduled_at ?? null);
  const serverIp = (body.server_ip ?? row.server_ip ?? null) || null;
  const serverPassword = (body.server_password ?? row.server_password ?? null) || null;
  const bo = [1,3].includes(Number(body.bo)) ? Number(body.bo) : Number(row.bo || getTournament(row.tournament_id)?.bo || 1);
  const scoreA = body.score_a === "" || body.score_a == null ? row.score_a : body.score_a;
  const scoreB = body.score_b === "" || body.score_b == null ? row.score_b : body.score_b;
  const winnerTeamId = (body.winner_team_id ?? row.winner_team_id ?? null) || null;

  db.prepare(`UPDATE bracket_matches SET team_a_id=?, team_b_id=?, scheduled_at=?, server_ip=?, server_password=?, bo=?, score_a=?, score_b=?, winner_team_id=?, updated_at=? WHERE id=?`)
    .run(teamAId, teamBId, scheduledAt, serverIp, serverPassword, bo, scoreA, scoreB, winnerTeamId, nowIso(), id);

  const updated = db.prepare(`SELECT * FROM bracket_matches WHERE id = ?`).get(id);
  if (updated.team_a_id && updated.team_b_id) syncMatchFromBracket(updated.id);
  if (winnerTeamId && updated.next_match_id && updated.next_slot) {
    const col = updated.next_slot === "A" ? "team_a_id" : "team_b_id";
    db.prepare(`UPDATE bracket_matches SET ${col} = ?, updated_at = ? WHERE id = ?`).run(winnerTeamId, nowIso(), updated.next_match_id);
  }

  res.json({ ok: true });
});



app.get("/tournament.html", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "tournament.html"));
});
app.get("/tournament-bracket.html", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "tournament-bracket.html"));
});
app.get("/tournament-rules.html", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "tournament-rules.html"));
});
app.get("/tournament-settings.html", (req, res) => {
  const s = getSession(req.cookies?.[SESSION_COOKIE]);
  if (!s || !s.user_id) return res.redirect("/login.html");
  const u = db.prepare(`SELECT role FROM users WHERE id = ?`).get(s.user_id);
  if (!u || u.role !== "admin") return res.redirect("/login.html");
  res.sendFile(path.join(process.cwd(), "public", "tournament-settings.html"));
});

app.get("/api/meta/gmail-setup", requireAdmin, (req, res) => {
  res.json({
    configured: !!getMailer(),
    needs: [
      "Создай Gmail-ящик для aftermatch или используй существующий",
      "Включи двухэтапную защиту в Google Account",
      "Создай App Password в разделе Security → App passwords",
      "Укажи GMAIL_USER и GMAIL_APP_PASSWORD в переменных окружения сервера",
      "Перезапусти сайт после сохранения переменных"
    ]
  });
});

app.get('/auth.html', (req, res) => res.sendFile(path.join(process.cwd(), 'public', 'auth.html')));
app.get('/home.html', (req, res) => res.sendFile(path.join(process.cwd(), 'public', 'tournaments.html')));

// Static files
app.use(express.static(path.join(process.cwd(), "public")));
app.use("/src", express.static(path.join(process.cwd(), "src"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".ico")) res.setHeader("Content-Type", "image/x-icon");
  }
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});



server.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] aftermatch.ru running on port ${PORT}`);
});
