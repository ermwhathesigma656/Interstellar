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
assert.match(html, /src="https:\/\/interstellar-gta5\.gonicvrnew\.workers\.dev\/\?low=1/);
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
console.log("GTA launch, isolation, existing-game routing, game relay ranges, and credential separation passed.");
