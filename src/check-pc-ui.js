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
const timers = new Map(); let timerId = 0;
let me = { username: "test", assigned: true, pcId: "pc-original" };
const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
const document = Object.assign(new EventTarget(), { getElementById: element,
  documentElement: { async requestFullscreen() { document.fullscreenElement = this; document.dispatchEvent(new Event("fullscreenchange")); } },
  async exitFullscreen() { document.fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); },
});
const desktops = [];
class FakeRFB extends EventTarget {
  constructor() { super(); desktops.push(this); }
  disconnect() {}
  focus() { this.focused = true; }
}
const source = (await readFile(new URL("../static/assets/js/pc.js", import.meta.url), "utf8"))
  .replace('await import("/pc-rfb.mjs")', 'await getRFB()');
runInNewContext(source, {
  document, crypto, AbortSignal, addEventListener() {}, setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  location: { protocol: "https:", host: "example.test" }, getRFB: async () => ({ default: FakeRFB }),
  fetch: async (url, options) => {
    const action = url.split("/").pop(); calls.push({ action, body: options.body && JSON.parse(options.body) });
    if (action === "delete") me.deleting = true;
    if (action === "start" && !me.assigned) me = { ...me, assigned: true, pcId: "pc-replacement" };
    return { ok: true, json: async () => action === "me" ? structuredClone(me) : action === "start" ? { lease: "one-pc-session", pcId: me.pcId } : action === "heartbeat" ? { ready: true } : action === "delete" ? { deleting: true } : { ok: true } };
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
assert.equal(desktops[0].showDotCursor, true);
await click("pc-fullscreen");
assert.equal(document.fullscreenElement, document.documentElement); // Includes body-mounted fallback cursor.
assert.equal(element("pc-fullscreen").textContent, "Exit full screen");
assert.equal(desktops[0].focused, true);
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
assert.equal(document.fullscreenElement, null);
await click("pc-delete");
assert.equal(element("pc-confirm").open, true);
assert.match(element("pc-confirm-message").textContent, /permanently delete.*All files, installed apps, and settings.*cannot be recovered/);
assert.equal(element("pc-confirm-accept").textContent, "Delete permanently");
await answer("cancel");
assert.equal(calls.filter(call => call.action === "delete").length, 0);
await click("pc-delete"); await answer("ok");
assert.deepEqual(calls.filter(call => call.action === "delete"), [{ action: "delete", body: { pcId: "pc-original", confirm: true } }]);
assert.equal(element("pc-start").disabled, true);
assert.equal(element("pc-delete").disabled, true);
await click("pc-start");
assert.equal(calls.filter(call => call.action === "start").length, 1);
const refresh = [...timers.values()].find(fn => fn.name === "refresh");
assert.equal(typeof refresh, "function");
me = { username: "test", assigned: false, pcId: null, deleting: false };
await refresh();
assert.equal(element("pc-auth").hidden, true);
assert.equal(element("pc-start").disabled, false);
assert.equal(element("pc-start-label").textContent, "Create my PC");
assert.equal(element("pc-delete").hidden, true);
assert.match(element("pc-status").textContent, /account is still here/);
await click("pc-start"); await click("pc-start");
assert.equal(calls.filter(call => call.action === "start").length, 2);
assert.equal(me.pcId, "pc-replacement");
console.log("PC page checks passed: single start, full-screen pointer/focus, power controls, deletion warning/cancel, wait for cleanup and one replacement without losing the account.");
