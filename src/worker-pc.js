import { DurableObject } from "cloudflare:workers";
import { azurePower, desktopFetch } from "./worker-azure.js";

const SESSION_DAYS = 30;
const LEASE_MS = 90000;
const COOKIE = "ispc";
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const tokenHash = async token => hex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
const reply = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256));
}
function sameText(a, b) {
  const left = encoder.encode(a), right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}
function cookie(request, value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

export async function pcApi(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if ((origin ? origin !== url.origin : request.method !== "GET" || request.headers.has("Upgrade")) || ["cross-site", "same-site"].includes(request.headers.get("Sec-Fetch-Site"))) {
    return reply({ error: "Open the PC page on this website to use your PC." }, 403);
  }
  if (!env.VIRTUAL_PC || !env.PC_RATE_LIMITER) return reply({ error: "PCs are not configured yet." }, 503);
  const action = url.pathname.slice("/api/pc/".length);
  const methods = { signup: "POST", login: "POST", logout: "POST", me: "GET", claim: "POST", start: "POST", heartbeat: "POST", release: "POST", desktop: "GET" };
  if (!methods[action]) return reply({ error: "Not found." }, 404);
  if (request.method !== methods[action]) return reply({ error: `Use ${methods[action]}.` }, 405);
  let body = {};
  if (request.method === "POST") {
    let text = "";
    let size = 0;
    const decoder = new TextDecoder();
    if (request.body) for await (const chunk of request.body) {
      size += chunk.byteLength;
      if (size > 4096) return reply({ error: "Request too large." }, 413);
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    try { body = text ? JSON.parse(text) : {}; } catch { return reply({ error: "Invalid request." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "Invalid request." }, 400);
  }
  if (["signup", "login", "claim"].includes(action)) {
    const { success } = await env.PC_RATE_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "local" });
    if (!success) return reply({ error: "Too many attempts. Please wait a minute." }, 429);
  }
  if (action === "signup" || action === "login") {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return reply({ error: "Usernames are 3–20 letters, numbers or underscores." }, 400);
    if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 200) return reply({ error: "Passwords are 8–200 characters." }, 400);
    const response = await env.VIRTUAL_PC.getByName(username).fetch(`https://pc/${action}`, { method: "POST", body: JSON.stringify({ username, password: body.password }) });
    const result = await response.json();
    if (!response.ok) return reply(result, response.status);
    return reply({ username }, 200, { "Set-Cookie": cookie(request, `${username}.${result.token}`, SESSION_DAYS * 86400) });
  }
  const session = request.headers.get("Cookie")?.match(/(?:^|;\s*)ispc=([a-z0-9_]{3,20})\.([a-f0-9]{64})(?:;|$)/);
  if (!session) return reply({ error: "Sign in to use your PC." }, 401);
  const headers = new Headers({ "X-Session": session[2] });
  if (action === "desktop") {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return reply({ error: "WebSocket required." }, 426);
    headers.set("Upgrade", "websocket");
    headers.set("X-Lease", url.searchParams.get("lease") || "");
  }
  const result = await env.VIRTUAL_PC.getByName(session[1]).fetch(`https://pc/${action}`, {
    method: request.method, headers, body: request.method === "POST" ? JSON.stringify(body) : null,
  });
  if (action === "logout" && result.ok) return reply({ ok: true }, 200, { "Set-Cookie": cookie(request, "", 0) });
  return result;
}

export class VirtualPC extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT, salt BLOB, hash TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER);
      CREATE TABLE IF NOT EXISTS machine_claims (machine TEXT PRIMARY KEY, username TEXT UNIQUE);`);
    // Existing ReactOS save tables remain intact; Windows uses its Azure disk.
  }
  async newSession() {
    const token = random();
    this.sql.exec("DELETE FROM sessions WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO sessions VALUES (?, ?)", await tokenHash(token), Date.now() + SESSION_DAYS * 86400000);
    return token;
  }
  machines() { return JSON.parse(this.env.PC_MACHINES || "[]"); }
  async machine() {
    const id = await this.ctx.storage.get("machine");
    return this.machines().find(item => item.id === id);
  }
  fetch(request) {
    // Serialize ownership changes and cloud power operations, including simultaneous tabs.
    return this.ctx.blockConcurrencyWhile(async () => {
      try { return await this.handle(request); }
      catch (error) {
        console.error("PC operation failed", error.message);
        return reply({ error: "Your PC could not complete that request. Please try again shortly." }, 503);
      }
    });
  }
  closeDesktop() {
    const sockets = this.sockets;
    this.sockets = null;
    for (const ws of sockets || []) { try { ws.close(1000, "Desktop session ended"); } catch {} }
  }
  async stop() {
    this.closeDesktop();
    const lease = await this.ctx.storage.get("lease");
    if (lease) await this.ctx.storage.put("lease", { ...lease, expires: 0, stopping: true });
    // Retry until Azure confirms deallocation, so a transient error cannot strand a paid VM.
    await this.ctx.storage.setAlarm(Date.now() + 30000);
    const machine = await this.machine();
    if (!machine) return;
    if (await azurePower(this.env, machine, "instanceView") !== "PowerState/deallocated") {
      await azurePower(this.env, machine, "deallocate");
      return;
    }
    await this.ctx.storage.delete("lease");
    await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const lease = await this.ctx.storage.get("lease");
      if (lease && !lease.stopping && lease.expires > Date.now()) {
        await this.ctx.storage.setAlarm(lease.expires);
        return;
      }
      try { await this.stop(); } catch { await this.ctx.storage.setAlarm(Date.now() + 30000); }
    });
  }
  async handle(request) {
    const action = new URL(request.url).pathname.slice(1);
    // Internal only: pcApi never forwards this route. Each VM gets one permanent owner.
    if (action === "assign") {
      const { username, invitation } = await request.json();
      const hash = await tokenHash(invitation);
      const machine = this.machines().find(item => sameText(item.invitationHash, hash));
      if (!machine) return reply({ error: "That activation code is invalid." }, 400);
      const owner = this.sql.exec("SELECT username FROM machine_claims WHERE machine = ?", machine.id).toArray()[0];
      if (owner && owner.username !== username) return reply({ error: "That PC already belongs to another account." }, 409);
      const existing = this.sql.exec("SELECT machine FROM machine_claims WHERE username = ?", username).toArray()[0];
      if (existing && existing.machine !== machine.id) return reply({ error: "This account already has a PC." }, 409);
      this.sql.exec("INSERT OR IGNORE INTO machine_claims VALUES (?, ?)", machine.id, username);
      return reply({ id: machine.id });
    }
    const account = this.sql.exec("SELECT username, salt, hash FROM account WHERE id = 1").toArray()[0];
    if (action === "signup") {
      const { username, password } = await request.json();
      if (account) return reply({ error: "That username is taken. Sign in instead, or pick another name." }, 409);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      this.sql.exec("INSERT INTO account VALUES (1, ?, ?, ?, ?)", username, salt, await passwordHash(password, salt), Date.now());
      return reply({ token: await this.newSession() });
    }
    if (action === "login") {
      const { password } = await request.json();
      const hash = await passwordHash(password, account ? new Uint8Array(account.salt) : new Uint8Array(16));
      if (!account || !sameText(hash, account.hash)) return reply({ error: "Wrong username or password." }, 401);
      return reply({ token: await this.newSession() });
    }
    const token = await tokenHash(request.headers.get("X-Session") || "");
    const session = account && this.sql.exec("SELECT expires FROM sessions WHERE token = ?", token).toArray()[0];
    if (!session || session.expires < Date.now()) return reply({ error: "Your sign-in expired. Please sign in again." }, 401);
    const machine = await this.machine();
    let lease = await this.ctx.storage.get("lease");
    if (action === "me") return reply({ username: account.username, assigned: !!machine, busy: !!lease, stopping: !!lease?.stopping });
    if (action === "logout") {
      if (lease?.session === token) await this.stop();
      this.sql.exec("DELETE FROM sessions WHERE token = ?", token);
      return reply({ ok: true });
    }
    const body = request.method === "POST" ? await request.json() : {};
    if (action === "claim") {
      if (machine) return reply({ error: "Your account already has a PC." }, 409);
      if (typeof body.invitation !== "string" || !/^[a-f0-9]{32}$/.test(body.invitation)) return reply({ error: "Enter your PC activation code." }, 400);
      const response = await this.env.VIRTUAL_PC.getByName("!registry").fetch("https://pc/assign", { method: "POST", body: JSON.stringify({ username: account.username, invitation: body.invitation }) });
      const result = await response.json();
      if (!response.ok) return reply(result, response.status);
      await this.ctx.storage.put("machine", result.id);
      return reply({ ok: true });
    }
    if (!machine) return reply({ error: "Activate your PC with the code from the site owner first." }, 409);
    if (action === "start") {
      if (typeof body.client !== "string" || !/^[a-f0-9-]{36}$/.test(body.client)) return reply({ error: "Invalid desktop session." }, 400);
      if (lease) {
        if (!lease.stopping && lease.expires > Date.now() && lease.session === token && lease.client === body.client) return reply({ lease: lease.id });
        if (lease.expires <= Date.now() && !lease.stopping) await this.stop();
        const stopping = lease.stopping || lease.expires <= Date.now();
        return reply({ code: stopping ? "PC_STOPPING" : "PC_IN_USE", error: stopping ? "Waiting for your PC to finish shutting down…" : "Your PC is open in another tab or device. Close that session first." }, 409);
      }
      lease = { id: random(), session: token, client: body.client, expires: Date.now() + LEASE_MS, readyBy: Date.now() + 600000 };
      await this.ctx.storage.put("lease", lease);
      await this.ctx.storage.setAlarm(lease.expires);
      await azurePower(this.env, machine, "start");
      return reply({ lease: lease.id });
    }
    const leaseId = action === "desktop" ? request.headers.get("X-Lease") : body.lease;
    if (!lease || lease.stopping || lease.expires <= Date.now() || lease.session !== token || !sameText(lease.id, typeof leaseId === "string" ? leaseId : "")) return reply({ error: "This desktop session ended. Start your PC again." }, 409);
    if (action === "release") { await this.stop(); return reply({ ok: true }); }
    if (action === "heartbeat") {
      lease.expires = Date.now() + LEASE_MS;
      await this.ctx.storage.put("lease", lease);
      await this.ctx.storage.setAlarm(lease.expires);
      let ready = !!this.sockets;
      if (!ready) try {
        const health = await desktopFetch(machine, "/health");
        ready = health.ok;
        if (!ready) console.warn("PC gateway health status", health.status);
      } catch (error) { console.warn("PC gateway connection", error.message); }
      if (!ready && lease.readyBy < Date.now()) {
        await this.stop();
        return reply({ error: "Windows did not respond. Your PC is shutting down; try starting it again shortly." }, 409);
      }
      if (ready) { lease.readyBy = Date.now() + 180000; await this.ctx.storage.put("lease", lease); }
      return reply({ ready });
    }
    if (action === "desktop") {
      if (this.sockets) return reply({ error: "This PC already has an active connection." }, 409);
      const upstream = await desktopFetch(machine, "/desktop", true);
      if (upstream.status !== 101 || !upstream.webSocket) return reply({ error: "Windows is still starting. Please wait." }, 503);
      const remote = upstream.webSocket;
      const [client, server] = Object.values(new WebSocketPair());
      remote.binaryType = "arraybuffer";
      server.binaryType = "arraybuffer";
      this.sockets = [server, remote];
      const bridge = (from, to, direction) => {
        let first = true;
        from.addEventListener("message", event => {
          if (first) { console.log("PC first frame", direction, typeof event.data, event.data.byteLength ?? event.data.length); first = false; }
          try { to.send(event.data); } catch (error) { console.warn("PC frame forwarding failed", error.message); this.closeDesktop(); }
        });
      };
      bridge(server, remote, "to Windows"); bridge(remote, server, "from Windows");
      const close = () => this.closeDesktop();
      for (const socket of this.sockets) { socket.addEventListener("close", close); socket.addEventListener("error", close); }
      remote.accept();
      server.accept();
      return new Response(null, { status: 101, webSocket: client });
    }
    return reply({ error: "Not found." }, 404);
  }
}
