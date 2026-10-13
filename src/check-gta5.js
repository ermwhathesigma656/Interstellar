import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { gta5Page } from "./gta5.js";
import gameHost from "./gta5-host.js";

const games = JSON.parse(await readFile("static/assets/json/games.min.json", "utf8"));
const game = games.find(entry => entry.name === "GTA V");
assert.ok(game);
await readFile(`static${game.image}`);
const launcher = await readFile("static/assets/js/launcher.js", "utf8");
// Production rewrites the canonical route; clean links and the player's Back button still work.
for (const pathname of ["/games", "/games.html", "/play.html", "/opaque-games"]) {
  const context = vm.createContext({ window: { location: { pathname } }, document: { addEventListener() {} } });
  vm.runInContext(launcher.replace('=== "/games"', '=== "/opaque-games"'), context);
  assert.equal(context.getJsonPath(), "/assets/json/games.min.json", `Game catalog at ${pathname}`);
}
for (const isInTabMode of [false, true]) {
  const window = { location: { pathname: "/games" }, top: { location: {} } };
  let proxyUrl;
  const context = vm.createContext({ window, isInTabMode, document: { addEventListener() {} }, go: url => { proxyUrl = url; } });
  vm.runInContext(launcher, context);
  context.handleAppClick(game);
  assert.equal(window.top.location.href, "/play/gta5", "GTA must leave any non-isolated tab wrapper");
  assert.equal(proxyUrl, undefined, "GTA must not run through the proxy");
  if (!isInTabMode) {
    context.handleAppClick({ link: "https://example.com/game" });
    assert.equal(proxyUrl, "https://example.com/game", "Existing games still use their usual launcher");
  }
}

const page = process.argv[2] ? await fetch(new URL(game.link, process.argv[2])) : gta5Page();
assert.equal(page.status, 200);
assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
assert.equal(page.headers.get("cross-origin-embedder-policy"), "require-corp");
assert.match(page.headers.get("permissions-policy"), /cross-origin-isolated=\(self "https:\/\/interstellar-gta5\.gonicvrnew\.workers\.dev"\)/);
assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
const html = await page.text();
assert.match(html, /allow="cross-origin-isolated; fullscreen; autoplay; gamepad"/);
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function player(saved, storageBlocked = false) {
  const elements = new Map();
  const launches = [];
  const writes = [];
  let approved = false;
  const context = vm.createContext({
    URL, URLSearchParams,
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } });
      return elements.get(id);
    } },
    localStorage: {
      getItem() { if (storageBlocked) throw new Error('Storage blocked'); return saved; },
      setItem(key, value) { if (storageBlocked) throw new Error('Storage blocked'); writes.push([key, value]); },
    },
    confirm: () => approved,
  });
  const frame = context.document.getElementById('game');
  Object.defineProperty(frame, 'src', { set(value) { launches.push(new URL(value)); } });
  vm.runInContext(script, context);
  return { elements, launches, writes, approve() { approved = true; }, submit() { elements.get('graphics').handlers.submit({ preventDefault() {} }); } };
}
for (const [saved, resolution] of [[null, '1280x720'], ['constructor', '1280x720'], ['performance', '960x540'], ['sharp', '1600x900']]) {
  const test = player(saved);
  assert.equal(test.launches.length, 1, 'Only start one engine on page load');
  assert.equal(test.launches[0].origin, 'https://interstellar-gta5.gonicvrnew.workers.dev');
  assert.equal(test.launches[0].searchParams.get('res'), resolution);
  assert.equal(test.launches[0].searchParams.get('fps'), '60');
  assert.equal(test.launches[0].searchParams.get('low'), '1');
  assert.equal(test.launches[0].searchParams.has('newgame'), false, 'Keep existing saved games');
  assert.equal(test.elements.get('apply').disabled, true);
}
for (const blocked of [false, true]) {
  const test = player(null, blocked);
  test.elements.get('quality').value = 'performance';
  test.elements.get('quality').handlers.change();
  assert.equal(test.elements.get('apply').disabled, false);
  assert.equal(test.launches.length, 1, 'Selecting a setting must not interrupt play');
  test.submit();
  assert.equal(test.launches.length, 1, 'Cancel must preserve the current session');
  assert.equal(test.writes.length, 0);
  test.approve();
  test.submit();
  assert.equal(test.launches.length, 2);
  assert.equal(test.launches[1].searchParams.get('res'), '960x540');
  assert.equal(test.elements.get('apply').disabled, true);
  assert.deepEqual(test.writes, blocked ? [] : [['gta5.graphics', 'performance']]);
  test.submit();
  assert.equal(test.launches.length, 2, 'Applying an unchanged setting must not restart');
  test.elements.get('game').requestFullscreen = async () => { throw new Error('Fullscreen unavailable'); };
  await test.elements.get('fullscreen').handlers.click();
  assert.match(test.elements.get('status').textContent, /Fullscreen is unavailable/);
}
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url.href, "https://gta5-87g.pages.dev/chunks/game/0?test=1");
    assert.equal(options.headers.get("range"), "bytes=0-3");
    assert.equal(options.headers.get("cookie"), null);
    assert.equal(options.headers.get("authorization"), null);
    return new Response(new Uint8Array([0, 97, 115, 109]), { status: 206, headers: {
      "Content-Range": "bytes 0-3/400",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Set-Cookie": "unwanted=1",
    } });
  };
  const forwarded = await gameHost.fetch(new Request("https://interstellar-gta5.gonicvrnew.workers.dev/chunks/game/0?test=1", {
    headers: { Range: "bytes=0-3", Cookie: "account=private", Authorization: "Bearer private" },
  }));
  assert.equal(forwarded.status, 206);
  assert.equal(forwarded.headers.get("content-range"), "bytes 0-3/400");
  assert.equal(forwarded.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(forwarded.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(forwarded.headers.get("set-cookie"), null);
  assert.deepEqual([...new Uint8Array(await forwarded.arrayBuffer())], [0, 97, 115, 109]);
  assert.equal((await gameHost.fetch(new Request("https://example.com/", { method: "POST" }))).status, 405);
  globalThis.fetch = async () => { throw new Error("Offline"); };
  assert.equal((await gameHost.fetch(new Request("https://example.com/"))).status, 502);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("GTA graphics presets, saved preferences, restart cancellation, launch isolation, game routing, relay ranges, and credential separation passed.");
