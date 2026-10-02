import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { timingSafeEqual, createHash } from "node:crypto";
import { provisioningConfig, newMachine, deploymentBody } from "./worker-provision.js";

// Run the real account/lease implementation against SQLite; replace only cloud I/O.
crypto.subtle.timingSafeEqual = timingSafeEqual;
let state = "PowerState/deallocated", failStop = false, bootId = "boot-1", gatewayReady = true;
const powerCalls = [];
let deploymentState = "Running", creations = 0;
let deleteComplete = false, failDelete = false, inventories = 0;
const deletedResources = [];
globalThis.pcTestProvision = { provisioningConfig, newMachine,
  provision: async (_env, _machine, create) => { if (create) creations++; return deploymentState; },
  deletionResources: async (_env, machine) => { inventories++; return [`${machine.id}/vm`, `${machine.id}/disk`]; },
  deleteResource: async (_env, resource) => { deletedResources.push(resource); if (failDelete) throw new Error("Simulated delete outage"); return deleteComplete; },
};
globalThis.pcTestPower = async (_env, _machine, action) => {
  powerCalls.push(action);
  if (action === "instanceView") return state;
  if (action === "deallocate" && failStop) throw new Error("Simulated Azure outage");
  state = action === "start" || action === "restart" ? "PowerState/running" : "PowerState/deallocated";
};
globalThis.pcTestDesktop = async (_machine, path, options) => {
  if (path === "/upload") { await new Response(options.body).arrayBuffer(); return Response.json({ name: "test.exe" }); }
  if (!gatewayReady) return new Response(null, { status: 503 });
  return Response.json({ bootId });
};
const source = (await readFile(new URL("worker-pc.js", import.meta.url), "utf8"))
  .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }')
  .replace('import { azurePower, desktopFetch } from "./worker-azure.js";', 'const azurePower = globalThis.pcTestPower; const desktopFetch = globalThis.pcTestDesktop;')
  .replace('import { provisioningConfig, newMachine, provision, deletionResources, deleteResource } from "./worker-provision.js";', 'const { provisioningConfig, newMachine, provision, deletionResources, deleteResource } = globalThis.pcTestProvision;');
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
const anotherRegion = { ...env, PC_AZURE: JSON.stringify({ provisioning: { ...provisioningConfig(env), location: "northcentralus" } }) };
const regionalMachine = newMachine(anotherRegion, "pc-123456abcdef");
assert.equal(regionalMachine.location, "northcentralus");
assert.match(regionalMachine.url, /\.northcentralus\.cloudapp\.azure\.com$/);
assert.ok(deploymentBody(anotherRegion, regionalMachine).properties.template.resources.every(item => item.location === "northcentralus"));
assert.ok(deploymentBody(anotherRegion, autoMachine).properties.template.resources.every(item => item.location === "mexicocentral"));
const oldMachine = { ...autoMachine }; delete oldMachine.location; delete oldMachine.firstBootLogin;
assert.ok(deploymentBody(anotherRegion, oldMachine).properties.template.resources.every(item => item.location === "mexicocentral"));
const windowsConfig = body => body.properties.template.resources.find(item => item.type === "Microsoft.Compute/virtualMachines").properties.osProfile.windowsConfiguration;
assert.deepEqual(windowsConfig(template).additionalUnattendContent.map(item => item.settingName), ["AutoLogon", "FirstLogonCommands"]);
assert.equal(windowsConfig(deploymentBody(env, oldMachine)).additionalUnattendContent, undefined);
assert.equal(template.properties.template.parameters.password.type, "secureString");
assert.equal(template.properties.template.parameters.command.type, "secureString");
assert.ok(!JSON.stringify(template.properties.template).includes(autoMachine.password));
assert.deepEqual(template.properties.template.resources.find(item => item.type.endsWith("networkSecurityGroups")).properties.securityRules[0].properties.destinationPortRanges, ["80", "443"]);
assert.equal((await (await call("heartbeat", { lease: autoLease }, fourth)).json()).provisioning, true);
const fifth = await account("person_five");
const atCapacity = await call("start", { client: crypto.randomUUID() }, fifth);
assert.equal(atCapacity.status, 409);
assert.equal((await atCapacity.json()).code, "PC_CAPACITY");
deploymentState = "Succeeded";
const restartsBeforeSetup = powerCalls.filter(action => action === "restart").length;
gatewayReady = false;
assert.deepEqual(await (await call("heartbeat", { lease: autoLease }, fourth)).json(), { ready: false, restarting: false });
gatewayReady = true;
assert.deepEqual(await (await call("heartbeat", { lease: autoLease }, fourth)).json(), { ready: true, restarting: false });
assert.equal(powerCalls.filter(action => action === "restart").length, restartsBeforeSetup);
assert.equal((await autoPC.machine()).password, undefined);
// Deployments created by an earlier worker still need their one-time login restart.
await autoPC.ctx.storage.put("provisioned", oldMachine);
assert.equal((await (await call("heartbeat", { lease: autoLease }, fourth)).json()).restarting, true);
assert.equal(powerCalls.filter(action => action === "restart").length, restartsBeforeSetup + 1);
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

// Destructive actions need an explicit confirmation tied to the current PC, not just the account.
assert.equal((await call("retire", { id: autoMachine.id }, fourth)).status, 404);
assert.equal((await call("delete", { pcId: autoMachine.id }, fourth)).status, 400);
assert.equal((await call("delete", { pcId: autoMachine.id, confirm: true }, fifth)).status, 409);
assert.equal((await call("delete", { pcId: autoMachine.id, confirm: true }, fourth, { Origin: "https://evil.test" })).status, 403);
assert.equal(await autoPC.ctx.storage.get("deletion"), undefined);
const deleteRequest = { pcId: autoMachine.id, confirm: true };
const duplicates = await Promise.all([call("delete", deleteRequest, fourth), call("delete", deleteRequest, fourth)]);
assert.deepEqual(duplicates.map(result => result.status), [202,202]);
assert.equal(inventories, 0); // Cloud cleanup runs in alarms, outside the confirmation request.
assert.equal((await (await call("me", undefined, fourth)).json()).deleting, true);
assert.equal((await (await call("start", { client: fourthClient }, fourth)).json()).code, "PC_DELETING");
assert.equal((await call("heartbeat", { lease: autoLease }, fourth)).status, 409);
assert.equal((await upload(fourth, autoLease)).status, 409);
await autoPC.alarm();
assert.equal(inventories, 1);
failDelete = true; await autoPC.alarm();
assert.equal((await (await call("me", undefined, fourth)).json()).deletionRetrying, true);
assert.equal((await autoPC.machine()).id, autoMachine.id);
failDelete = false; await autoPC.alarm();
assert.equal((await autoPC.ctx.storage.get("deletion")).resources.length, 2);
assert.equal((await call("logout", {}, fourth)).status, 200); // Signing out must not cancel deletion.
assert.ok(await autoPC.ctx.storage.get("alarm"));
deleteComplete = true;
await autoPC.alarm();
assert.equal((await autoPC.ctx.storage.get("deletion")).resources.length, 1);
assert.equal((await autoPC.machine()).id, autoMachine.id); // Keep ownership until the disk is also gone.
await autoPC.alarm(); await autoPC.alarm();
assert.equal(await autoPC.machine(), undefined);
assert.equal(await autoPC.ctx.storage.get("alarm"), undefined);
assert.equal(await autoPC.ctx.storage.get("lease"), undefined);
const signIn = async username => (await call("login", { username, password: "password-123" })).headers.get("Set-Cookie").split(";")[0];
const fourthAgain = await signIn("person_four");
assert.equal((await (await call("me", undefined, fourthAgain)).json()).assigned, false);
assert.equal((await call("delete", deleteRequest, fourthAgain)).status, 200);
const newAttempts = await Promise.all([1,2].map(() => call("start", { client: crypto.randomUUID() }, fourthAgain)));
assert.deepEqual(newAttempts.map(result => result.status).sort(), [200,409]);
assert.notEqual((await autoPC.machine()).id, autoMachine.id);
assert.equal((await call("delete", deleteRequest, fourthAgain)).status, 409); // Delayed confirmation cannot erase a replacement.

// A retired preconfigured machine must never be handed to any account again.
const firstAgain = await signIn("person_one");
assert.equal((await call("delete", { pcId: "pc-1", confirm: true }, firstAgain)).status, 202);
for (let index = 0; index < 4; index++) await pc.alarm();
assert.equal(await pc.machine(), undefined);
assert.equal((await call("start", { client: crypto.randomUUID() }, firstAgain)).status, 200);
assert.match((await pc.machine()).id, /^pc-[a-f0-9]{12}$/);
assert.equal(objects.get("!registry").sql.exec("SELECT COUNT(*) AS count FROM machine_claims WHERE username = ?", "person_one").toArray()[0].count, 1);
const sixth = await account("person_six");
assert.equal((await call("start", { client: crypto.randomUUID() }, sixth)).status, 409);

// Initial deployment must stop creating resources before its deletion inventory is captured.
deploymentState = "Running";
const replacement = await autoPC.machine(), previousInventories = inventories;
assert.equal((await call("delete", { pcId: replacement.id, confirm: true }, fourthAgain)).status, 202);
await autoPC.alarm();
assert.equal(inventories, previousInventories);
deploymentState = "Failed";
for (let index = 0; index < 5; index++) await autoPC.alarm();
assert.equal(await autoPC.machine(), undefined);
assert.equal(await autoPC.ctx.storage.get("deletion"), undefined);
assert.equal((await pendingPC.machine()).id, pendingMachine.id); // Other accounts are untouched.
console.log("PC checks passed: account/session isolation, capacity, provisioning, power, uploads, confirmed deletion, cleanup retries, retired inventory and one replacement per account.");

// Exercise the real Azure resource-selection and delete polling code with recorded cloud responses.
let azureReplies = [], azureCalls = [];
globalThis.pcTestAzureRequest = async (_env, resource, options = {}) => {
  azureCalls.push({ resource, method: options.method || "GET" });
  assert.ok(azureReplies.length, "Unexpected Azure request");
  const [status, body = {}] = azureReplies.shift();
  return Response.json(body, { status });
};
const cleanupSource = (await readFile(new URL("worker-provision.js", import.meta.url), "utf8"))
  .replace('import { azureRequest } from "./worker-azure.js";', 'const azureRequest = globalThis.pcTestAzureRequest;');
const cleanup = await import(`data:text/javascript;base64,${Buffer.from(cleanupSource).toString("base64")}`);
const legacy = { id: "interstellar-pc-01", resourceId: `${provisioningConfig(env).resourceGroup}/providers/Microsoft.Compute/virtualMachines/interstellar-pc-01` };
const diskId = `${provisioningConfig(env).resourceGroup.toUpperCase()}/providers/Microsoft.Compute/disks/interstellar-pc-01_OsDisk_1_abcdef`;
azureReplies = [[200, { properties: { storageProfile: { osDisk: { managedDisk: { id: diskId } } } } }]];
const resources = await cleanup.deletionResources(env, legacy);
assert.equal(resources.length, 5);
assert.equal(resources[1], `${diskId}?api-version=2024-03-02`);
assert.match(resources[2], /interstellar-pc-01VMNic\?/);
assert.equal(resources.some(resource => resource.includes("virtualNetworks")), false); // Legacy VNet is shared.
const current = newMachine(env, "pc-123456789abc");
const currentDisk = `${provisioningConfig(env).resourceGroup}/providers/Microsoft.Compute/disks/${current.id}_OsDisk_1_123abc`;
azureReplies = [[404], [200, { value: [{ id: currentDisk }, { id: diskId }] }]];
const partialResources = await cleanup.deletionResources(env, current);
assert.ok(partialResources.includes(`${currentDisk}?api-version=2024-03-02`));
assert.ok(!partialResources.includes(`${diskId}?api-version=2024-03-02`));
assert.match(partialResources[2], /pc-123456789abc-nic\?/);
azureReplies = [[200, { properties: {} }], [200, { value: [{ id: currentDisk }] }]];
assert.ok((await cleanup.deletionResources(env, current)).includes(`${currentDisk}?api-version=2024-03-02`));
await assert.rejects(cleanup.deletionResources(env, { ...legacy, resourceId: legacy.resourceId.replace("test-sub", "other-sub") }), /outside/);
azureReplies = [[200, { properties: { storageProfile: { osDisk: { managedDisk: { id: `${diskId}-other/child` } } } } }]];
await assert.rejects(cleanup.deletionResources(env, legacy), /unexpected disk/);
azureReplies = [[200, { properties: { networkProfile: { networkInterfaces: [{ id: "/some-shared-nic" }] } } }]];
await assert.rejects(cleanup.deletionResources(env, legacy), /unexpected network/);
azureCalls = []; azureReplies = [[200], [202], [200, { properties: { provisioningState: "Deleting" } }], [404]];
assert.equal(await cleanup.deleteResource(env, resources[0]), false);
assert.equal(await cleanup.deleteResource(env, resources[0]), false);
assert.equal(await cleanup.deleteResource(env, resources[0]), true);
assert.equal(azureCalls.filter(call => call.method === "DELETE").length, 1);
azureReplies = [[200], [409]];
assert.equal(await cleanup.deleteResource(env, resources[1]), false);
azureReplies = [[403]];
await assert.rejects(cleanup.deleteResource(env, resources[1]), /Could not check/);
console.log("Azure deletion checks passed: exact resource scope, legacy and partial deployments, persisted disk IDs, 202/404 confirmation and retryable conflicts.");
