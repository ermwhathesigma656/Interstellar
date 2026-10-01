import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { timingSafeEqual, createHash } from "node:crypto";

// Run the real account/lease implementation against SQLite; replace only cloud I/O.
crypto.subtle.timingSafeEqual = timingSafeEqual;
let state = "PowerState/deallocated", failStop = false;
const powerCalls = [];
globalThis.pcTestPower = async (_env, _machine, action) => {
  powerCalls.push(action);
  if (action === "instanceView") return state;
  if (action === "deallocate" && failStop) throw new Error("Simulated Azure outage");
  state = action === "start" ? "PowerState/running" : "PowerState/deallocated";
};
const source = (await readFile(new URL("worker-pc.js", import.meta.url), "utf8"))
  .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }')
  .replace('import { azurePower, desktopFetch } from "./worker-azure.js";', 'const azurePower = globalThis.pcTestPower; const desktopFetch = async () => new Response("ready");');
const { pcApi, VirtualPC } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const objects = new Map();
const invitation = "1".repeat(32);
const env = { PC_RATE_LIMITER: { limit: async () => ({ success: true }) }, PC_MACHINES: JSON.stringify([
  { id: "pc-1", invitationHash: createHash("sha256").update(invitation).digest("hex") },
]) };
env.VIRTUAL_PC = { getByName(name) {
  if (!objects.has(name)) {
    const db = new DatabaseSync(":memory:"), values = new Map();
    let queue = Promise.resolve();
    const ctx = { storage: {
      sql: { exec(query, ...args) {
        if (query.includes("CREATE TABLE")) { db.exec(query); return { toArray: () => [] }; }
        return { toArray: () => db.prepare(query).all(...args) };
      } },
      get: async key => structuredClone(values.get(key)), put: async (key, value) => { values.set(key, structuredClone(value)); },
      delete: async key => values.delete(key), setAlarm: async value => values.set("alarm", value), deleteAlarm: async () => values.delete("alarm"),
    }, blockConcurrencyWhile(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; } };
    // SQLite writes execute immediately, as they do in a Durable Object.
    const exec = ctx.storage.sql.exec;
    ctx.storage.sql.exec = (...args) => { const rows = exec(...args).toArray(); return { toArray: () => rows }; };
    objects.set(name, new VirtualPC(ctx, env));
  }
  const object = objects.get(name);
  return { fetch: (url, options) => object.fetch(new Request(url, options)) };
} };
const origin = "https://example.test";
const call = (action, body, session, extra = {}) => pcApi(new Request(`${origin}/api/pc/${action}`, {
  method: body === undefined ? "GET" : "POST", headers: { Origin: origin, ...(session ? { Cookie: session } : {}), ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env);
const account = async username => {
  const result = await call("signup", { username, password: "password-123" });
  assert.equal(result.status, 200); return result.headers.get("Set-Cookie").split(";")[0];
};
assert.equal((await call("me")).status, 401);
assert.equal((await call("assign", {})).status, 404);
assert.equal((await call("signup", {}, null, { Origin: "https://evil.test" })).status, 403);
assert.equal((await call("signup", { password: "x".repeat(5000) })).status, 413);
const first = await account("person_one"), second = await account("person_two");
assert.equal((await call("start", { client: crypto.randomUUID() }, second)).status, 409);
assert.equal((await call("claim", { invitation }, first)).status, 200);
assert.equal((await call("claim", { invitation }, second)).status, 409);
const clients = [crypto.randomUUID(), crypto.randomUUID()];
const attempts = await Promise.all(clients.map(client => call("start", { client }, first)));
assert.deepEqual(attempts.map(item => item.status).sort(), [200,409]);
const winner = attempts.findIndex(item => item.status === 200);
const { lease } = await attempts[winner].json();
env.PC_RATE_LIMITER.limit = async () => ({ success: false });
assert.equal((await (await call("start", { client: clients[winner] }, first)).json()).lease, lease);
assert.equal((await call("login", { username: "person_one", password: "password-123" })).status, 429);
env.PC_RATE_LIMITER.limit = async () => ({ success: true });
assert.equal((await call("release", { lease }, second)).status, 409);
assert.equal((await call("heartbeat", { lease: "bad" }, first)).status, 409);
assert.equal((await call("heartbeat", { lease }, first)).status, 200);
const pc = objects.get("person_one");
await pc.alarm();
assert.equal(powerCalls.filter(action => action === "deallocate").length, 0);
const saved = await pc.ctx.storage.get("lease");
await pc.ctx.storage.put("lease", { ...saved, expires: Date.now() - 1 });
failStop = true;
await pc.alarm();
assert.equal((await pc.ctx.storage.get("lease")).stopping, true);
const shuttingDown = await call("start", { client: crypto.randomUUID() }, first);
assert.equal(shuttingDown.status, 409);
assert.equal((await shuttingDown.json()).code, "PC_STOPPING");
assert.ok(await pc.ctx.storage.get("alarm"));
failStop = false;
await pc.alarm(); // Deallocation accepted.
await pc.alarm(); // Deallocation confirmed.
assert.equal(await pc.ctx.storage.get("lease"), undefined);
assert.equal(await pc.ctx.storage.get("alarm"), undefined);
assert.equal((await call("heartbeat", { lease }, first)).status, 409);
const restarted = await call("start", { client: crypto.randomUUID() }, first);
assert.equal(restarted.status, 200);
assert.notEqual((await restarted.json()).lease, lease);
assert.equal((await call("logout", {}, first)).status, 200);
assert.equal((await call("me", undefined, first)).status, 401);
console.log("PC checks passed: account isolation, single-use activation, simultaneous-tab exclusion, lease renewal/expiry, Azure retry, restart and logout.");
