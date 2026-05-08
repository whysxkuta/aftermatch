import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db, initSchema, nowIso } from "./db.js";

const BASE_URL = "http://192.168.1.100:4000";

initSchema();

db.exec(`
DELETE FROM team_invites;
DELETE FROM team_members;
DELETE FROM sessions;
DELETE FROM users;
DELETE FROM matches;
DELETE FROM teams;
DELETE FROM tournaments;
DELETE FROM servers;
`);

const s1 = nanoid(10);
const s2 = nanoid(10);
db.prepare(`INSERT INTO servers (id, name, ip, port, rcon_password, is_active) VALUES (?, ?, ?, ?, ?, ?)`)
  .run(s1, "Server #1", "192.168.1.200", 27015, "", 1);
db.prepare(`INSERT INTO servers (id, name, ip, port, rcon_password, is_active) VALUES (?, ?, ?, ?, ?, ?)`)
  .run(s2, "Server #2", "192.168.1.201", 27015, "", 1);

const adminId = nanoid(10);
const hash = await bcrypt.hash("whySxkuta_SC1", 10);
db.prepare(`INSERT INTO users (id, nickname, password_hash, first_name, last_name, steam_id64, role, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(adminId, "root", hash, "Admin", "Admin", null, "admin", nowIso());

console.log("Seed done.");
console.log("Admin login:", "root / whySxkuta_SC1");
console.log("Open:", BASE_URL);
console.log("Teams:", `${BASE_URL}/teams.html`);
