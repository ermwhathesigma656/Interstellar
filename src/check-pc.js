import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { timingSafeEqual, createHash } from "node:crypto";
import { provisioningConfig, newMachine, deploymentBody } from "./worker-provision.js";

// Run the real account/lease implementation against SQLite; replace only cloud I/O.
crypto.subtle.timingSafeEqual = timingSafeEqual;
let state = "PowerState/deallocated", failStop = false, bootId = "boot-1";
const powerCalls = [];
let deploymentState = "Running", creations = 0;
globalThis.pcTestProvision = { provisioningConfig, newMachine, provision: async (_env, _machine, create) => { if (create) creations++; return deploymentState; } };
globalThis.pcTestPower = async (_env, _machine, action) => {
  powerCalls.push(action);
  if (action === "instanceView") return state;
  if (action === "deallocate" && failStop) throw new Error("Simulated Azure outage");
  state = action === "start" || action === "restart" ? "PowerState/running" : "PowerState/deallocated";
};
globalThis.pcTestDesktop = async (_machine, path, options) => {
  if (path === "/upload") { await new Response(options.body).arrayBuffer(); return Response.json({ name: "test.exe" }); }
  return Response.json({ bootId });
};
const source = (await readFile(new URL("worker-pc.js", import.meta.url), "utf8"))
  .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }')
  .replace('import { azurePower, desktopFetch } from "./worker-azure.js";', 'const azurePower = globalThis.pcTestPower; const desktopFetch = globalThis.pcTestDesktop;')
  .replace('import { provisioningConfig, newMachine, provision } from "./worker-provision.js";', 'const { provisioningConfig, newMachine, provision } = globalThis.pcTestProvision;');
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
assert.equal((await call("claim", { invitation }, first)).status, 404);
const clients = [crypto.randomUUID(), crypto.randomUUID()];
const attempts = await Promise.all(clients.map(client => call("start", { client }, first)));
assert.deepEqual(attempts.map(item => item.status).sort(), [200,409]);
const winner = attempts.findIndex(item => item.status === 200);
const { lease } = await attempts[winner].json();
assert.equal((await call("start", { client: crypto.randomUUID() }, second)).status, 409);
assert.equal((await objects.get("person_one").ctx.storage.get("machine")), "pc-1");
env.PC_RATE_LIMITER.limit = async () => ({ success: false });
assert.equal((await (await call("start", { client: clients[winner] }, first)).json()).lease, lease);
assert.equal((await call("login", { username: "person_one", password: "password-123" })).status, 429);
env.PC_RATE_LIMITER.limit = async () => ({ success: true });
assert.equal((await call("release", { lease }, second)).status, 409);
assert.equal((await call("heartbeat", { lease: "bad" }, first)).status, 409);
assert.equal((await call("heartbeat", { lease }, first)).status, 200);
const pc = objects.get("person_one");
// An old connection's delayed close must leave the replacement running.
let oldClosed = 0, newClosed = 0;
const oldSockets = [{ close: () => oldClosed++ }], newSockets = [{ close: () => newClosed++ }];
pc.sockets = newSockets;
pc.closeDesktop(oldSockets);
assert.equal(pc.sockets, newSockets); assert.equal(oldClosed, 1); assert.equal(newClosed, 0);
pc.closeDesktop(); assert.equal(newClosed, 1); assert.equal(pc.sockets, null);
assert.equal((await call("restart", { lease: "wrong" }, first)).status, 409);
assert.equal((await call("restart", { lease }, second)).status, 409);
assert.equal((await call("restart", { lease }, first)).status, 200);
assert.equal((await pc.ctx.storage.get("lease")).id, lease);
assert.equal((await (await call("heartbeat", { lease }, first)).json()).ready, false);
assert.equal((await call("restart", { lease }, first)).status, 409);
bootId = "boot-2";
assert.equal((await (await call("heartbeat", { lease }, first)).json()).ready, true);
assert.equal((await pc.ctx.storage.get("lease")).restarting, undefined);
const upload = (session, leaseId, length = "4", data = "test", originHeader = origin) => pcApi(new Request(`${origin}/api/pc/upload`, {
  method: "POST", headers: { Origin: originHeader, Cookie: session, "X-Lease": leaseId, "X-Filename": "test.exe", "Content-Length": length }, body: data,
}), env);
assert.equal((await upload(first, lease)).status, 200);
assert.equal((await upload(first, "wrong")).status, 409);
assert.equal((await upload(second, lease)).status, 409);
assert.equal((await upload(first, lease, "999999999")).status, 413);
assert.equal((await upload(first, lease, "1", "test")).status, 503);
assert.equal((await upload(first, lease, "4", "test", "https://evil.test")).status, 403);
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
env.PC_MACHINES = JSON.stringify([{ id: "pc-1" }, { id: "pc-2" }]);
const third = await account("person_three");
const remaining = await Promise.all([second, third].map(session => call("start", { client: crypto.randomUUID() }, session)));
assert.deepEqual(remaining.map(item => item.status).sort(), [200,409]);
const assigned = await objects.get(remaining[0].status === 200 ? "person_two" : "person_three").ctx.storage.get("machine");
assert.equal(assigned, "pc-2");
assert.equal(await pc.ctx.storage.get("machine"), "pc-1");
env.PC_AZURE = JSON.stringify({ provisioning: { resourceGroup: "/subscriptions/test-sub/resourceGroups/test", location: "mexicocentral", maxPCs: 3, sourceRoot: "https://example.test/scripts" } });
const fourth = await account("person_four"), fourthClient = crypto.randomUUID();
const autoStart = await call("start", { client: fourthClient }, fourth);
assert.equal(autoStart.status, 200);
const autoLease = (await autoStart.json()).lease;
assert.equal(creations, 1);
assert.equal((await call("start", { client: fourthClient }, fourth)).status, 200);
assert.equal(creations, 1); // Reloads/repeated clicks never create another VM for this account.
const autoPC = objects.get("person_four"), autoMachine = await autoPC.machine();
assert.match(autoMachine.id, /^pc-[a-f0-9]{12}$/);
const template = deploymentBody(env, autoMachine);
assert.equal(template.properties.template.parameters.password.type, "secureString");
assert.equal(template.properties.template.parameters.command.type, "secureString");
assert.ok(!JSON.stringify(template.properties.template).includes(autoMachine.password));
assert.deepEqual(template.properties.template.resources.find(item => item.type.endsWith("networkSecurityGroups")).properties.securityRules[0].properties.destinationPortRanges, ["80", "443"]);
assert.equal((await (await call("heartbeat", { lease: autoLease }, fourth)).json()).provisioning, true);
const fifth = await account("person_five");
assert.equal((await call("start", { client: crypto.randomUUID() }, fifth)).status, 409);
deploymentState = "Succeeded";
assert.equal((await (await call("heartbeat", { lease: autoLease }, fourth)).json()).restarting, true);
assert.equal((await autoPC.machine()).password, undefined);
bootId = "boot-after-provision";
assert.equal((await (await call("heartbeat", { lease: autoLease }, fourth)).json()).ready, true);
assert.equal((await upload(fourth, autoLease)).status, 200);
assert.equal((await call("restart", { lease: autoLease }, first)).status, 401);
env.PC_AZURE = JSON.stringify({ ...JSON.parse(env.PC_AZURE), provisioning: { ...provisioningConfig(env), maxPCs: 4 } });
deploymentState = "Running";
const pending = await call("start", { client: crypto.randomUUID() }, fifth);
assert.equal(pending.status, 200);
const pendingPC = objects.get("person_five"), pendingMachine = await pendingPC.machine();
const pendingLease = await pendingPC.ctx.storage.get("lease");
await pendingPC.ctx.storage.put("lease", { ...pendingLease, expires: Date.now() - 1 });
await pendingPC.alarm();
assert.equal((await pendingPC.machine()).provisioning, true);
assert.equal((await pendingPC.ctx.storage.get("lease")).stopping, true);
deploymentState = "Succeeded";
await pendingPC.alarm(); await pendingPC.alarm();
assert.equal(await pendingPC.ctx.storage.get("lease"), undefined);
assert.equal((await pendingPC.machine()).password, undefined);
const createdBeforeResume = creations;
assert.equal((await call("start", { client: crypto.randomUUID() }, fifth)).status, 200);
assert.equal((await pendingPC.machine()).id, pendingMachine.id);
assert.equal(creations, createdBeforeResume);
console.log("PC checks passed: automatic assignment, capacity limits, account isolation, simultaneous-tab exclusion, lease expiry, Azure retry, restart, upload authorization and logout.");
