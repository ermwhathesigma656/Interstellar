import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { runInNewContext } from "node:vm";

class Element extends EventTarget {
  children = []; value = ""; hidden = false;
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this[name] = value; }
}
const elements = new Map();
const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
const urls = [];
runInNewContext(await readFile(new URL("../static/assets/js/ports.js", import.meta.url), "utf8"), {
  document: { getElementById: element, createElement: () => new Element() },
  go: url => urls.push(url),
});
const cards = element("ports-grid").children;
assert.equal(cards.length, 22);
assert.equal(element("ports-count").textContent, "22 of 22 games");
assert.equal(element("ports-empty").hidden, true);
for (const card of cards) {
  assert.equal(card.type, "button");
  assert.match(card["aria-label"], /^Open .+ inside Interstellar$/);
  await access(new URL(`../static${card.children[0].src}`, import.meta.url));
  card.dispatchEvent(new Event("click"));
}
assert.equal(new Set(urls).size, 22);
for (const url of urls) {
  assert.equal(new URL(url).protocol, "https:");
  assert.doesNotMatch(url, /t\.co|moon-zombies|kino-der-toten|cheese-cube|lkgp\.pro/);
}
assert.ok(urls.includes("https://shar-wasm.cjoseph.workers.dev/?skipmovie"));
const search = query => { element("ports-search").value = query; element("ports-search").dispatchEvent(new Event("input")); };
search("  qUaKe  ");
assert.equal(cards.filter(card => !card.hidden).length, 3);
assert.equal(element("ports-count").textContent, "3 of 22 games");
search("Unreal Tournament");
assert.equal(cards.filter(card => !card.hidden)[0].children[1].children[0].textContent, "Urban Terror");
search("no such game");
assert.equal(element("ports-empty").hidden, false);
assert.equal(cards.filter(card => !card.hidden).length, 0);
search("");
assert.equal(cards.filter(card => !card.hidden).length, 22);
console.log("Ports checks passed: all local icons, 22 distinct in-app launches, retained query strings, excluded redirects, search and empty state.");
