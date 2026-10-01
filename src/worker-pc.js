import { DurableObject } from "cloudflare:workers";
import { azurePower, desktopFetch } from "./worker-azure.js";
import { provisioningConfig, newMachine, provision, deletionResources, deleteResource } from "./worker-provision.js";

const SESSION_DAYS = 30;
const LEASE_MS = 180000;
const MAX_UPLOAD = 50 * 1024 * 1024;
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
  const methods = { signup: "POST", login: "POST", logout: "POST", me: "GET", start: "POST", delete: "POST", restart: "POST", upload: "POST", heartbeat: "POST", release: "POST", desktop: "GET" };
  if (!methods[action]) return reply({ error: "Not found." }, 404);
  if (request.method !== methods[action]) return reply({ error: `Use ${methods[action]}.` }, 405);
  let body = {};
  if (action === "upload") {
    const length = request.headers.get("Content-Length");
    if (!request.body || !length || !/^\d+$/.test(length) || Number(length) < 1 || Number(length) > MAX_UPLOAD) return reply({ error: "Choose a file between 1 byte and 50 MB." }, 413);
    body = { lease: request.headers.get("X-Lease") };
  } else if (request.method === "POST") {
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
  if (["signup", "login"].includes(action)) {
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
  if (action === "upload" && result.ok) {
    // Authorize inside the account lock; stream outside it so transfers cannot pause desktop input.
    const machine = await result.json();
    let size = 0;
    const limited = request.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_UPLOAD || size > Number(request.headers.get("Content-Length"))) throw new Error("Upload too large");
      controller.enqueue(chunk);
    } }));
    try {
      const uploaded = await desktopFetch(machine, "/upload", { method: "POST", body: limited, headers: {
        "Content-Type": "application/octet-stream", "X-Filename": request.headers.get("X-Filename") || "",
        "X-File-Size": request.headers.get("Content-Length"),
      } });
      return reply(await uploaded.json(), uploaded.status);
    } catch { return reply({ error: "The upload was interrupted. Reconnect to Windows and try again." }, 503); }
  }
  if (action === "logout" && result.ok) return reply({ ok: true }, 200, { "Set-Cookie": cookie(request, "", 0) });
  return result;
}

export class VirtualPC extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT, salt BLOB, hash TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER);
      CREATE TABLE IF NOT EXISTS machine_claims (machine TEXT PRIMARY KEY, username TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS retired_machines (machine TEXT PRIMARY KEY);`);
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
    const provisioned = await this.ctx.storage.get("provisioned");
    if (provisioned) return provisioned;
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
  closeDesktop(sockets = this.sockets) {
    // Late events from an old connection must never close its replacement.
    if (this.sockets === sockets) this.sockets = null;
    for (const ws of sockets || []) { try { ws.close(1000, "Desktop session ended"); } catch {} }
  }
  async stop() {
    if (await this.ctx.storage.get("deletion")) return;
    this.closeDesktop();
    const lease = await this.ctx.storage.get("lease");
    if (lease) await this.ctx.storage.put("lease", { ...lease, expires: 0, stopping: true });
    // Retry until Azure confirms deallocation, so a transient error cannot strand a paid VM.
    await this.ctx.storage.setAlarm(Date.now() + 30000);
    const machine = await this.machine();
    if (!machine) { await this.ctx.storage.delete("lease"); await this.ctx.storage.deleteAlarm(); return; }
    if (machine.provisioning) {
      const state = await provision(this.env, machine);
      if (!["Succeeded", "Failed", "Canceled", "Missing"].includes(state)) return;
      machine.provisioning = false;
      machine.failed = state !== "Succeeded";
      if (!machine.failed) delete machine.password;
      await this.ctx.storage.put("provisioned", machine);
    }
    if (await azurePower(this.env, machine, "instanceView") !== "PowerState/deallocated") {
      await azurePower(this.env, machine, "deallocate");
      return;
    }
    await this.ctx.storage.delete("lease");
    await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const deletion = await this.ctx.storage.get("deletion");
      if (deletion) {
        await this.ctx.storage.setAlarm(Date.now() + 10000);
        try { await this.removePC(deletion); }
        catch (error) {
          console.warn("PC deletion will retry", error.message);
          await this.ctx.storage.put("deletion", { ...deletion, retrying: true });
          await this.ctx.storage.setAlarm(Date.now() + 30000);
        }
        return;
      }
      const lease = await this.ctx.storage.get("lease");
      if (lease && !lease.stopping && lease.expires > Date.now()) {
        await this.ctx.storage.setAlarm(lease.expires);
        return;
      }
      try { await this.stop(); } catch { await this.ctx.storage.setAlarm(Date.now() + 30000); }
    });
  }
  async removePC(deletion) {
    this.closeDesktop();
    deletion.retrying = false;
    const machine = deletion.machine;
    if (machine.provisioning) {
      const state = await provision(this.env, machine);
      if (["Succeeded", "Failed", "Canceled", "Missing"].includes(state)) machine.provisioning = false;
    } else if (!deletion.resources) {
      deletion.resources = await deletionResources(this.env, machine);
    } else if (deletion.resources.length) {
      if (await deleteResource(this.env, deletion.resources[0])) deletion.resources.shift();
    } else {
      const response = await this.env.VIRTUAL_PC.getByName("!registry").fetch("https://pc/retire", {
        method: "POST", body: JSON.stringify({ username: deletion.username, id: machine.id }),
      });
      if (!response.ok) throw new Error("Could not release deleted PC ownership");
      await this.ctx.storage.put("lastDeleted", machine.id);
      for (const key of ["machine", "provisioned", "lease", "deletion"]) await this.ctx.storage.delete(key);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.put("deletion", deletion);
  }
  async handle(request) {
    const action = new URL(request.url).pathname.slice(1);
    // Internal only: pcApi never forwards registry routes. One live VM per account.
    if (action === "retire") {
      const { username, id } = await request.json();
      const claim = this.sql.exec("SELECT username FROM machine_claims WHERE machine = ?", id).toArray()[0];
      if (claim && claim.username !== username) return reply({ error: "PC belongs to another account." }, 409);
      this.sql.exec("INSERT OR IGNORE INTO retired_machines VALUES (?)", id);
      this.sql.exec("DELETE FROM machine_claims WHERE machine = ? AND username = ?", id, username);
      return reply({ ok: true });
    }
    if (action === "assign") {
      const { username } = await request.json();
      const existing = this.sql.exec("SELECT machine FROM machine_claims WHERE username = ?", username).toArray()[0];
      if (existing) return reply({ id: existing.machine, automatic: !this.machines().some(item => item.id === existing.machine) });
      const owned = new Set(this.sql.exec("SELECT machine FROM machine_claims").toArray().map(item => item.machine));
      const retired = new Set(this.sql.exec("SELECT machine FROM retired_machines").toArray().map(item => item.machine));
      let machine = this.machines().find(item => !owned.has(item.id) && !retired.has(item.id));
      const config = provisioningConfig(this.env);
      const automatic = !machine;
      if (!machine && config && owned.size < config.maxPCs) machine = { id: `pc-${random().slice(0,12)}` };
      if (!machine) return reply({ code: "PC_CAPACITY", error: "All PC slots on this website are assigned. Each account can have one PC, but the site's total hosting limit is full. Delete an unused PC from its owning account or ask the site owner to add capacity." }, 409);
      this.sql.exec("INSERT OR IGNORE INTO machine_claims VALUES (?, ?)", machine.id, username);
      return reply({ id: machine.id, automatic });
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
    let machine = await this.machine();
    let lease = await this.ctx.storage.get("lease");
    const deletion = await this.ctx.storage.get("deletion");
    if (action === "me") return reply({ username: account.username, assigned: !!machine, pcId: machine?.id || null, busy: !!lease, stopping: !!lease?.stopping, deleting: !!deletion, deletionRetrying: !!deletion?.retrying });
    if (action === "logout") {
      if (lease?.session === token) await this.stop();
      this.sql.exec("DELETE FROM sessions WHERE token = ?", token);
      return reply({ ok: true });
    }
    const body = request.method === "POST" ? await request.json() : {};
    if (action === "delete") {
      if (body.confirm !== true || typeof body.pcId !== "string") return reply({ error: "Confirm that you want to permanently delete this PC and all its files." }, 400);
      if (!machine && body.pcId === await this.ctx.storage.get("lastDeleted")) return reply({ deleting: false });
      if (!machine || body.pcId !== machine.id) return reply({ error: "Your PC has changed. Reload the page before deleting it." }, 409);
      if (!deletion) {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        await this.ctx.storage.put("deletion", { username: account.username, machine });
        this.closeDesktop();
      }
      return reply({ deleting: true }, 202);
    }
    if (deletion) return reply({ code: "PC_DELETING", error: "Your PC is being deleted. You can create a new one when deletion finishes." }, 409);
    if (action === "start") {
      if (typeof body.client !== "string" || !/^[a-f0-9-]{36}$/.test(body.client)) return reply({ error: "Invalid desktop session." }, 400);
      if (!machine) {
        const response = await this.env.VIRTUAL_PC.getByName("!registry").fetch("https://pc/assign", { method: "POST", body: JSON.stringify({ username: account.username }) });
        const result = await response.json();
        if (!response.ok) return reply(result, response.status);
        if (result.automatic) await this.ctx.storage.put("provisioned", newMachine(this.env, result.id));
        await this.ctx.storage.put("machine", result.id);
        machine = await this.machine();
      }
      if (!machine) return reply({ error: "Your PC is temporarily unavailable. Contact the site owner." }, 503);
      if (lease) {
        if (!lease.stopping && lease.expires > Date.now() && lease.session === token && lease.client === body.client) return reply({ lease: lease.id, pcId: machine.id });
        if (lease.expires <= Date.now() && !lease.stopping) await this.stop();
        const stopping = lease.stopping || lease.expires <= Date.now();
        return reply({ code: stopping ? "PC_STOPPING" : "PC_IN_USE", error: stopping ? "Waiting for your PC to finish shutting down…" : "Your PC is open in another tab or device. Close that session first." }, 409);
      }
      if (machine.failed) { machine.provisioning = true; machine.failed = false; await this.ctx.storage.put("provisioned", machine); }
      lease = { id: random(), session: token, client: body.client, expires: Date.now() + LEASE_MS, readyBy: Date.now() + (machine.provisioning ? 1500000 : 600000) };
      await this.ctx.storage.put("lease", lease);
      await this.ctx.storage.setAlarm(lease.expires);
      if (machine.provisioning) await provision(this.env, machine, true);
      else await azurePower(this.env, machine, "start");
      return reply({ lease: lease.id, pcId: machine.id });
    }
    if (!machine) return reply({ error: "Start your PC first." }, 409);
    const leaseId = action === "desktop" ? request.headers.get("X-Lease") : body.lease;
    if (!lease || lease.stopping || lease.expires <= Date.now() || lease.session !== token || !sameText(lease.id, typeof leaseId === "string" ? leaseId : "")) return reply({ error: "This desktop session ended. Start your PC again." }, 409);
    if (action === "release") { await this.stop(); return reply({ ok: true }); }
    if (action === "upload") {
      if (lease.restarting || machine.provisioning) return reply({ error: "Wait for Windows to finish starting before uploading." }, 409);
      return reply({ id: machine.id, url: machine.url, key: machine.key });
    }
    if (action === "restart") {
      if (machine.provisioning) return reply({ error: "Windows is still being installed. Please wait." }, 409);
      if (lease.restarting) return reply({ error: "Windows is already restarting." }, 409);
      let bootId = "unavailable";
      try { bootId = (await (await desktopFetch(machine, "/health")).json()).bootId || bootId; } catch {}
      await azurePower(this.env, machine, "restart");
      this.closeDesktop();
      lease.restarting = bootId;
      lease.readyBy = Date.now() + 600000;
      lease.expires = Date.now() + LEASE_MS;
      await this.ctx.storage.put("lease", lease);
      await this.ctx.storage.setAlarm(lease.expires);
      return reply({ ok: true });
    }
    if (action === "heartbeat") {
      lease.expires = Date.now() + LEASE_MS;
      await this.ctx.storage.put("lease", lease);
      await this.ctx.storage.setAlarm(lease.expires);
      if (machine.provisioning) {
        const state = await provision(this.env, machine);
        if (["Failed", "Canceled"].includes(state)) {
          await this.stop();
          return reply({ error: "Azure could not finish creating Windows. Check the subscription's credits and VM quota before trying again." }, 409);
        }
        if (state !== "Succeeded") {
          if (lease.readyBy < Date.now()) { await this.stop(); return reply({ error: "Windows setup took too long. Your PC will shut down safely after setup completes." }, 409); }
          if (state === "Missing") await provision(this.env, machine, true);
          return reply({ ready: false, provisioning: true });
        }
        let bootId = "unavailable";
        try { bootId = (await (await desktopFetch(machine, "/health")).json()).bootId || bootId; } catch {}
        await azurePower(this.env, machine, "restart");
        machine.provisioning = false;
        delete machine.password;
        await this.ctx.storage.put("provisioned", machine);
        lease.restarting = bootId;
        lease.readyBy = Date.now() + 600000;
        await this.ctx.storage.put("lease", lease);
        return reply({ ready: false, restarting: true });
      }
      let ready = !!this.sockets && !lease.restarting;
      if (!ready) try {
        const health = await desktopFetch(machine, "/health");
        const info = health.ok ? await health.json() : {};
        ready = health.ok && !!info.bootId && info.bootId !== lease.restarting;
        if (!ready) console.warn("PC gateway health status", health.status);
      } catch (error) { console.warn("PC gateway connection", error.message); }
      if (!ready && lease.readyBy < Date.now()) {
        await this.stop();
        return reply({ error: "Windows did not respond. Your PC is shutting down; try starting it again shortly." }, 409);
      }
      if (ready) { delete lease.restarting; lease.readyBy = Date.now() + 180000; await this.ctx.storage.put("lease", lease); }
      return reply({ ready, restarting: !!lease.restarting });
    }
    if (action === "desktop") {
      if (lease.restarting || machine.provisioning) return reply({ error: "Windows is starting." }, 503);
      this.closeDesktop();
      const upstream = await desktopFetch(machine, "/desktop", { headers: { Upgrade: "websocket" } });
      if (upstream.status !== 101 || !upstream.webSocket) return reply({ error: "Windows is still starting. Please wait." }, 503);
      const remote = upstream.webSocket;
      const [client, server] = Object.values(new WebSocketPair());
      remote.binaryType = "arraybuffer";
      server.binaryType = "arraybuffer";
      const sockets = [server, remote];
      this.sockets = sockets;
      const bridge = (from, to, direction) => {
        let first = true;
        from.addEventListener("message", event => {
          if (first) { console.log("PC first frame", direction, typeof event.data, event.data.byteLength ?? event.data.length); first = false; }
          try { to.send(event.data); } catch (error) { console.warn("PC frame forwarding failed", error.message); this.closeDesktop(sockets); }
        });
      };
      bridge(server, remote, "to Windows"); bridge(remote, server, "from Windows");
      const close = () => this.closeDesktop(sockets);
      for (const socket of sockets) { socket.addEventListener("close", close); socket.addEventListener("error", close); }
      remote.accept();
      server.accept();
      return new Response(null, { status: 101, webSocket: client });
    }
    return reply({ error: "Not found." }, 404);
  }
}
