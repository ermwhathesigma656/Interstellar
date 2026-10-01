import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";

// Use the ws dependency already installed with wisp-js; the Windows installer installs it separately.
const require = createRequire(import.meta.resolve("@mercuryworkshop/wisp-js"));
const gatewayModule = { exports: {} };
new Function("require", "module", await readFile(new URL("../scripts/pc-gateway.cjs", import.meta.url), "utf8"))(require, gatewayModule);
const downloads = await mkdtemp(path.join(tmpdir(), "interstellar-upload-check-"));
const server = gatewayModule.exports.createGateway({ key: "test-key", downloads });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const upload = (name, data = "MZ-test-file-not-an-executable", size = Buffer.byteLength(data), key = "test-key") => fetch(`${url}/upload`, {
  method: "POST", headers: { Authorization: `Bearer ${key}`, "X-Filename": encodeURIComponent(name), "X-File-Size": String(size) }, body: data,
});
try {
  assert.equal((await fetch(`${url}/health`)).status, 403);
  const health = await fetch(`${url}/health`, { headers: { Authorization: "Bearer test-key" } });
  assert.match((await health.json()).bootId, /^[a-f0-9-]{36}$/);
  assert.equal((await upload("test.exe", "data", 4, "wrong-key")).status, 403);
  for (const name of ["../escape.exe", "..\\escape.exe", "C:\\escape.exe", "file.exe:stream", "CON.exe", "LPT1", "file.", "file ", "bad\n.exe", ".."]) {
    assert.equal((await upload(name)).status, 400, name);
  }
  assert.equal((await upload("large.exe", "x", 51 * 1024 * 1024)).status, 413);
  const result = await upload("test.exe");
  assert.equal(result.status, 200);
  assert.equal((await result.json()).name, "test.exe");
  assert.equal(await readFile(path.join(downloads, "test.exe"), "utf8"), "MZ-test-file-not-an-executable");
  assert.equal((await upload("test.exe", "overwrite attempt")).status, 409);
  assert.equal(await readFile(path.join(downloads, "test.exe"), "utf8"), "MZ-test-file-not-an-executable");
  assert.equal((await upload("short.exe", "x", 2)).status, 400);
  // A following request also verifies the previous upload's cleanup has completed.
  assert.equal((await upload("Unicode café.txt", "ok")).status, 200);
  const files = await readdir(downloads);
  assert.deepEqual(files.sort(), ["Unicode café.txt", "test.exe"]);
  console.log("PC gateway checks passed: authentication, Windows filenames, size limits, atomic uploads, no overwrite, Unicode and incomplete transfers.");
} finally {
  server.closeAllConnections(); server.close(); await once(server, "close");
  // Only the freshly-created test directory under the system temp directory is removed.
  assert.equal(path.dirname(downloads), tmpdir());
  await rm(downloads, { recursive: true, force: true });
}
