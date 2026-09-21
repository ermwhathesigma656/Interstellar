import { builtinModules } from "node:module";
import { build } from "esbuild";

// Resolve Node entry points, not browser-only replacements for server libraries.
await build({
  entryPoints: ["src/worker.js"],
  outfile: "dist/.runtime/worker.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  minify: true,
  external: [...builtinModules, "node:*", "cloudflare:*", "bufferutil", "utf-8-validate"],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire("/worker.mjs");' },
});
