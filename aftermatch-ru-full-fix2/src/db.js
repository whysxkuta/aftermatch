import Database from "better-sqlite3";

export const db = new Database("data.db");

export function nowIso() {
  return new Date().toISOString();
}

export function initSchema() {
  db.exec(
    "CREATE TABLE IF NOT EXISTS users (" +
      "id TEXT PRIMARY KEY," +
      "nickname TEXT UNIQUE NOT NULL," +
      "password_hash TEXT NOT NULL," +
      "first_name TEXT NOT NULL," +
      "last_name TEXT NOT NULL," +
      "middle_name TEXT," +
      "steam_id64 TEXT UNIQUE," +
      "steam_profile_name TEXT," +
      "role TEXT NOT NULL DEFAULT 'player'," +
      "created_at TEXT NOT NULL" +
    ");" +

    "CREATE TABLE IF NOT EXISTS sessions (" +
      "id TEXT PRIMARY KEY," +
      "user_id TEXT," +
      "pending_steam_id64 TEXT," +
      "pending_steam_profile_name TEXT," +
      "expires_at TEXT NOT NULL," +
      "created_at TEXT NOT NULL" +
    ");" +

    "CREATE TABLE IF NOT EXISTS tournaments (" +
      "id TEXT PRIMARY KEY," +
      "name TEXT NOT NULL," +
      "description TEXT," +
      "prize TEXT," +
      "cover_url TEXT," +
      "mode TEXT NOT NULL," +
      "bo INTEGER NOT NULL," +
      "map_pool_json TEXT NOT NULL," +
      "created_at TEXT NOT NULL" +
    ");" +

    "CREATE TABLE IF NOT EXISTS teams (" +
      "id TEXT PRIMARY KEY," +
      "tournament_id TEXT," +
      "name TEXT NOT NULL," +
      "tag TEXT," +
      "description TEXT," +
      "avatar_url TEXT," +
      "created_at TEXT NOT NULL" +
    ");" +

    "CREATE TABLE IF NOT EXISTS team_members (" +
      "team_id TEXT NOT NULL," +
      "user_id TEXT NOT NULL," +
      "role TEXT NOT NULL," +
      "joined_at TEXT NOT NULL," +
      "PRIMARY KEY (team_id, user_id)" +
    ");" +

    "CREATE TABLE IF NOT EXISTS team_invites (" +
      "id TEXT PRIMARY KEY," +
      "team_id TEXT NOT NULL," +
      "invited_user_id TEXT NOT NULL," +
      "invited_by_user_id TEXT NOT NULL," +
      "status TEXT NOT NULL," +
      "created_at TEXT NOT NULL," +
      "responded_at TEXT" +
    ");" +

    "CREATE TABLE IF NOT EXISTS servers (" +
      "id TEXT PRIMARY KEY," +
      "name TEXT NOT NULL," +
      "ip TEXT NOT NULL," +
      "port INTEGER NOT NULL," +
      "rcon_password TEXT," +
      "is_active INTEGER NOT NULL DEFAULT 1" +
    ");" +

    "CREATE TABLE IF NOT EXISTS matches (" +
      "id TEXT PRIMARY KEY," +
      "tournament_id TEXT NOT NULL," +
      "team_a_id TEXT NOT NULL," +
      "team_b_id TEXT NOT NULL," +
      "status TEXT NOT NULL," +
      "server_id TEXT," +
      "connect_password TEXT," +
      "veto_state_json TEXT," +
      "result_json TEXT," +
      "created_at TEXT NOT NULL," +
      "updated_at TEXT NOT NULL" +
    ");"
  );

  // indices
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_name_ci ON teams(lower(name))"); } catch {}

  // migrations (safe)
  try { db.exec("ALTER TABLE users ADD COLUMN middle_name TEXT"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN steam_profile_name TEXT"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN pending_steam_profile_name TEXT"); } catch {}
  try { db.exec("ALTER TABLE tournaments ADD COLUMN description TEXT"); } catch {}
  try { db.exec("ALTER TABLE tournaments ADD COLUMN prize TEXT"); } catch {}
  try { db.exec("ALTER TABLE tournaments ADD COLUMN cover_url TEXT"); } catch {}

  try { db.exec("ALTER TABLE teams ADD COLUMN tag TEXT"); } catch {}
  try { db.exec("ALTER TABLE teams ADD COLUMN description TEXT"); } catch {}
  try { db.exec("ALTER TABLE teams ADD COLUMN avatar_url TEXT"); } catch {}
}

try { db.exec("ALTER TABLE tournaments ADD COLUMN page_cover_url TEXT"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN prize_places INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN prize_1 TEXT"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN prize_2 TEXT"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN prize_3 TEXT"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN bracket_mode TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN banned_until TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN ban_reason TEXT"); } catch {}


try { db.exec("ALTER TABLE tournaments ADD COLUMN checkin_until TEXT"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN matches_start_at TEXT"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN max_teams INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN page_cover_url TEXT"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN prize_places INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN prize_1 TEXT"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN prize_2 TEXT"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN prize_3 TEXT"); } catch {}
try { db.exec("ALTER TABLE tournaments ADD COLUMN bracket_mode TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN banned_until TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN ban_reason TEXT"); } catch {}
try {
  db.exec("CREATE TABLE IF NOT EXISTS tournament_registrations (" +
    "tournament_id TEXT NOT NULL," +
    "team_id TEXT NOT NULL," +
    "registered_by_user_id TEXT NOT NULL," +
    "created_at TEXT NOT NULL," +
    "PRIMARY KEY (tournament_id, team_id)" +
  ");");
} catch {}

