import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";

// Run the real page controller with a small DOM stand-in; no browser popup or Azure VM is needed.
class Element extends EventTarget {
  dataset = {}; value = "5"; open = false;
  replaceChildren() {}
  showModal() { this.open = true; }
}
const elements = new Map(), calls = [];
const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
const document = { getElementById: element, addEventListener() {} };
runInNewContext(await readFile(new URL("../static/assets/js/pc.js", import.meta.url), "utf8"), {
  document, crypto, AbortSignal, addEventListener() {}, setTimeout() { return 1; }, clearTimeout() {},
  fetch: async (url, options) => {
    const action = url.split("/").pop(); calls.push({ action, body: options.body && JSON.parse(options.body) });
    return { ok: true, json: async () => action === "me" ? { username: "test", assigned: true } : action === "start" ? { lease: "one-pc-session" } : action === "heartbeat" ? { ready: false } : { ok: true } };
  },
});
const click = async id => { element(id).dispatchEvent(new Event("click")); await setImmediate(); };
const answer = async value => {
  const dialog = element("pc-confirm"); dialog.returnValue = value; dialog.open = false;
  dialog.dispatchEvent(new Event("close")); await setImmediate();
};
await setImmediate();
await click("pc-start");
await click("pc-start");
assert.equal(calls.filter(call => call.action === "start").length, 1);
await click("pc-restart");
assert.equal(element("pc-confirm").open, true);
assert.match(element("pc-confirm-message").textContent, /Save your work/);
assert.equal(element("pc-confirm-accept").textContent, "Restart");
await answer("cancel");
assert.equal(calls.filter(call => call.action === "restart").length, 0);
await click("pc-restart"); await answer("ok");
assert.deepEqual(calls.filter(call => call.action === "restart"), [{ action: "restart", body: { lease: "one-pc-session" } }]);
await click("pc-stop"); await answer("cancel");
assert.equal(calls.filter(call => call.action === "release").length, 0);
await click("pc-stop"); await answer("ok");
assert.equal(calls.filter(call => call.action === "release").length, 1);
console.log("PC page checks passed: one start, in-page confirmation, cancel preserves the PC, restart retains its lease, shutdown releases it.");
