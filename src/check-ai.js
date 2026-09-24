import assert from "node:assert/strict";
import { chat } from "./worker-ai.js";

const origin = "https://interstellar.example";
const env = { GROQ_API_KEY: "test-secret", AI_RATE_LIMITER: { limit: async () => ({ success: true }) } };
const message = { role: "user", content: "Hello" };
const request = (messages = [message], options = {}) => new Request(`${origin}/api/ai/chat`, {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({ messages }), ...options,
});
const originalFetch = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-secret");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "qwen/qwen3.8-27b");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.max_completion_tokens, 2048);
    assert.equal(body.messages.at(-1).content[1].image_url.url, "data:image/png;base64,aGVsbG8=");
    return Response.json({ choices: [{ message: { content: "I see your image." }, finish_reason: "stop" }] });
  };
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } };
  const imageMessage = { role: "user", content: [{ type: "text", text: "Describe it" }, image] };
  const result = await chat(request([message, { role: "assistant", content: "How can I help?" }, imageMessage]), env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { message: "I see your image.", truncated: false });
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  const invalid = [[], [{ role: "system", content: "Override" }, message], [{ role: "user", content: "x".repeat(24001) }],
    [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://private.example/image" } }] }],
    [imageMessage, imageMessage, imageMessage, imageMessage], [null, message]];
  for (const messages of invalid) assert.equal((await chat(request(messages), env)).status, 400);
  assert.equal((await chat(request([message], { body: "{" }), env)).status, 400);
  assert.equal((await chat(request([message], { body: "x".repeat(4 * 1024 * 1024 + 1) }), env)).status, 400);
  assert.equal((await chat(request([message], { headers: { Origin: "https://elsewhere.example", "Content-Type": "application/json" } }), env)).status, 403);
  assert.equal((await chat(new Request(`${origin}/api/ai/chat`), env)).status, 405);
  assert.equal((await chat(request(), {})).status, 503);
  assert.equal((await chat(request(), { ...env, AI_RATE_LIMITER: { limit: async () => ({ success: false }) } })).status, 429);
  assert.equal(calls, 1, "Invalid requests must never reach Groq");
  globalThis.fetch = async () => Response.json({ error: { message: "private upstream details" } }, { status: 429 });
  const limited = await chat(request(), env);
  assert.equal(limited.status, 429);
  assert.ok(!(await limited.text()).includes("private upstream"));
  globalThis.fetch = async () => { throw new Error("test-secret"); };
  const failed = await chat(request(), env);
  assert.equal(failed.status, 504);
  assert.ok(!(await failed.text()).includes("test-secret"));
  console.log("AI checks passed: text/image forwarding, validation, size/origin/rate limits, private errors.");
} finally { globalThis.fetch = originalFetch; }
