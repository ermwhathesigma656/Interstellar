const MAX_BODY = 4 * 1024 * 1024;
const MODEL = "qwen/qwen3.8-27b";

function reply(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function readMessages(request) {
  if (!request.body || Number(request.headers.get("Content-Length")) > MAX_BODY) throw new Error("Request too large.");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new Error("Request too large.");
    }
    chunks.push(value);
  }
  const { messages } = JSON.parse(await new Blob(chunks).text());
  if (!Array.isArray(messages) || !messages.length || messages.length > 21 || messages.at(-1)?.role !== "user") {
    throw new Error("Invalid conversation.");
  }
  let images = 0;
  let characters = 0;
  return messages.map(message => {
    if (!message || !["user", "assistant"].includes(message.role)) throw new Error("Invalid message.");
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (!Array.isArray(parts) || !parts.length || parts.length > 4) throw new Error("Invalid message.");
    const content = parts.map(part => {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        characters += part.text.length;
        if (characters > 24000) throw new Error("Conversation too long. Start a new chat.");
        return { type: "text", text: part.text };
      }
      const url = part?.image_url?.url;
      if (message.role === "user" && part?.type === "image_url" && typeof url === "string" &&
          url.length <= 1100000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) {
        if (++images > 3) throw new Error("Use at most 3 images.");
        return { type: "image_url", image_url: { url } };
      }
      throw new Error("Use text or a JPEG, PNG, or WebP image under 800 KB after resizing.");
    });
    return { role: message.role, content: message.role === "assistant" ? content.map(part => part.text).join("\n") : content };
  });
}

export async function chat(request, env) {
  if (request.method !== "POST") return reply({ error: "Use POST." }, 405, { Allow: "POST" });
  if (request.headers.get("Origin") !== new URL(request.url).origin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return reply({ error: "Open AI from this website to send a message." }, 403);
  }
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return reply({ error: "Expected JSON." }, 415);
  if (!env.GROQ_API_KEY || !env.AI_RATE_LIMITER) return reply({ error: "AI is not configured yet. Please contact the site owner." }, 503);
  const { success } = await env.AI_RATE_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "local" });
  if (!success) return reply({ error: "Too many messages. Please wait a minute and try again." }, 429, { "Retry-After": "60" });
  let messages;
  try { messages = await readMessages(request); }
  catch (error) { return reply({ error: error instanceof SyntaxError ? "Invalid message data." : error.message }, 400); }
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60000)]),
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: "You are Interstellar AI, a helpful assistant. Answer clearly and honestly. You can analyze attached images, but you cannot browse the web or take actions. Use plain text and fenced code blocks when useful." }, ...messages],
        reasoning_effort: "none", max_completion_tokens: 2048, temperature: 0.7, stream: false,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) return reply({ error: "Groq's usage limit has been reached. Please try again later." }, 429);
      if ([401, 403].includes(response.status)) return reply({ error: "Groq could not authorize this chat. The site owner needs to check the API key and model access." }, 503);
      if (response.status === 400 || response.status === 413) return reply({ error: "Groq could not read this conversation. Try a smaller image or start a new chat." }, 400);
      return reply({ error: "Groq is temporarily unavailable. Please try again." }, 502);
    }
    const data = await response.json();
    const message = data.choices?.[0]?.message?.content;
    if (typeof message !== "string" || !message.trim()) return reply({ error: "No answer was returned. Please try again." }, 502);
    return reply({ message, truncated: data.choices[0].finish_reason === "length" });
  } catch {
    return reply({ error: "The response was interrupted or took too long. Please try again." }, 504);
  }
}
