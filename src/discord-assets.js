import { DurableObject } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";

// Only public, content-hashed files use the shared browser/cache. No account traffic.
export function discordAssetURL(url) {
  if (url.protocol !== "https:" || url.port || url.username || url.password ||
      !["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(url.hostname) ||
      !/^\/assets\/(?=[^/]*[a-f0-9]{8})[a-zA-Z0-9_.-]{1,200}$/.test(url.pathname)) return null;
  return "https://discord.com" + url.pathname;
}

export class DiscordAssets extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS assets (url TEXT, part INTEGER, type TEXT, body BLOB, expires INTEGER, PRIMARY KEY(url, part))");
    this.sql.exec("CREATE INDEX IF NOT EXISTS assets_expiry ON assets(expires)");
    this.pending = new Map();
    this.active = 0;
    this.queue = [];
    this.lastLaunch = ctx.storage.kv.get("browser-launched") || 0;
  }

  async fetch(request) {
    const url = discordAssetURL(new URL(request.url));
    if (!url || !["GET", "HEAD"].includes(request.method)) return new Response("Invalid asset", { status: 400 });
    let rows = this.sql.exec("SELECT type, body FROM assets WHERE url = ? AND expires > ? ORDER BY part", url, Date.now()).toArray();
    const cached = rows.length > 0;
    if (!cached) {
      if (!this.pending.has(url)) this.pending.set(url, this.load(url).finally(() => this.pending.delete(url)));
      try {
        const result = await this.pending.get(url);
        if (result.status !== 200) return new Response(result.body, { status: result.status });
        rows = [{ type: result.type, body: result.body }];
      } catch (error) {
        console.error("Discord asset fetch failed:", error.message);
        return new Response("Discord's app files are temporarily unavailable. Cloudflare's free browser allowance may be exhausted; try again later.", { status: 503 });
      }
    }
    return new Response(request.method === "HEAD" ? null : new Blob(rows.map(row => row.body)).stream(), {
      headers: { "Content-Type": rows[0].type, "Cache-Control": "public, max-age=604800, immutable", "X-Asset-Cache": cached ? "hit" : "miss" },
    });
  }

  async browserPage() {
    this.session ??= (async () => {
      // Free accounts may start only one browser every 20 seconds.
      const delay = this.lastLaunch + 21000 - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      this.lastLaunch = Date.now();
      this.ctx.storage.kv.put("browser-launched", this.lastLaunch);
      const browser = await puppeteer.launch(this.env.BROWSER);
      try {
        const page = await browser.newPage();
        await page.goto("https://discord.com/robots.txt", { waitUntil: "domcontentloaded", timeout: 15000 });
        return { browser, page };
      } catch (error) {
        await browser.close();
        throw error;
      }
    })().catch(error => { this.session = null; throw error; });
    return (await this.session).page;
  }

  async load(url) {
    clearTimeout(this.idle);
    if (this.active >= 4) await new Promise(resolve => this.queue.push(resolve));
    else this.active++;
    try {
      let response = await fetch(url, { headers: { "Accept-Encoding": "identity" }, redirect: "manual" });
      let body, type = response.headers.get("Content-Type") || "application/octet-stream";
      if (response.status === 400 && (await response.clone().text()) === "Bad Worker Origin") {
        await response.body.cancel();
        const page = await this.browserPage();
        const result = await page.evaluate(async address => {
          const res = await fetch(address, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000) });
          if (!res.ok) return { status: res.status };
          const reader = res.body.getReader();
          let binary = "", size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error("Asset exceeds 16 MiB"); }
            for (let offset = 0; offset < value.length; offset += 16384) binary += String.fromCharCode(...value.subarray(offset, offset + 16384));
          }
          return { status: res.status, type: res.headers.get("Content-Type"), body: btoa(binary) };
        }, url);
        if (result.status !== 200) return { status: result.status, body: "Discord asset unavailable" };
        type = result.type || type;
        body = Buffer.from(result.body, "base64");
      } else {
        if (response.status !== 200) { await response.body.cancel(); return { status: response.status, body: "Discord asset unavailable" }; }
        body = new Uint8Array(await response.arrayBuffer());
      }
      // ponytail: public files up to 16 MiB; stream larger assets if Discord adds them.
      if (body.length > 16 * 1024 * 1024) throw new Error("Asset exceeds 16 MiB");
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM assets WHERE expires < ? OR url = ?", Date.now(), url);
        // SQLite rows are limited to 2 MiB; use 1 MiB parts, reassembled above.
        for (let part = 0; part * 1048576 < body.length; part++) {
          this.sql.exec("INSERT INTO assets VALUES (?, ?, ?, ?, ?)", url, part, type, body.subarray(part * 1048576, (part + 1) * 1048576), Date.now() + 604800000);
        }
      });
      return { status: 200, type, body };
    } finally {
      if (this.queue.length) this.queue.shift()();
      else this.active--;
      if (!this.active && this.session) this.idle = setTimeout(() => {
        const session = this.session;
        this.session = null;
        session.then(({ browser }) => browser.close()).catch(error => console.error("Browser close:", error.message));
      }, 8000);
    }
  }
}
