(() => {
  const form = document.getElementById("ai-form");
  const input = document.getElementById("ai-input");
  const messages = document.getElementById("ai-messages");
  const welcome = document.getElementById("ai-welcome");
  const files = document.getElementById("ai-files");
  const attachments = document.getElementById("ai-attachments");
  const upload = document.getElementById("ai-upload");
  const send = document.getElementById("ai-send");
  const stop = document.getElementById("ai-stop");
  const reset = document.getElementById("ai-new");
  const status = document.getElementById("ai-status");
  let history = [];
  let images = [];
  let controller;
  let preparing = false;

  function notice(text = "", error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
  }
  function controls() {
    const busy = !!controller || preparing;
    input.disabled = busy;
    send.disabled = busy;
    upload.disabled = busy;
    reset.disabled = busy;
    stop.hidden = !controller;
    attachments.querySelectorAll("button").forEach(button => { button.disabled = busy; });
  }
  function picture(url, alt) {
    const image = document.createElement("img");
    image.className = "ai-image";
    image.src = url;
    image.alt = alt;
    return image;
  }
  function renderAttachments() {
    attachments.replaceChildren();
    images.forEach((image, index) => {
      const item = document.createElement("div");
      item.className = "ai-attachment";
      const name = document.createElement("span");
      name.textContent = image.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${image.name}`);
      remove.addEventListener("click", () => { images.splice(index, 1); renderAttachments(); });
      item.append(picture(image.url, image.name), name, remove);
      attachments.append(item);
    });
  }
  function addMessage(role, content) {
    welcome.hidden = true;
    const article = document.createElement("article");
    article.className = "ai-message";
    article.dataset.role = role;
    const heading = document.createElement("h3");
    heading.textContent = role === "user" ? "You" : "Interstellar AI";
    article.append(heading);
    for (const part of content) {
      if (part.type === "image_url") article.append(picture(part.image_url.url, "Uploaded image"));
      else {
        // Render code fences without ever interpreting model output as HTML.
        part.text.split(/```(?:[^\n`]*\n)?/).forEach((text, index) => {
          const block = document.createElement(index % 2 ? "pre" : "p");
          block.textContent = text;
          article.append(block);
        });
      }
    }
    messages.append(article);
    messages.scrollTop = messages.scrollHeight;
    return article;
  }
  async function prepare(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
      throw new Error("Choose JPEG, PNG, or WebP images under 10 MB each.");
    }
    let bitmap;
    try { bitmap = await createImageBitmap(file); }
    catch { throw new Error(`Could not read ${file.name}. Try another image.`); }
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const url = canvas.toDataURL("image/jpeg", 0.8);
    if (url.length > 1100000) throw new Error("That image is too detailed. Try a smaller image.");
    return { name: file.name, url };
  }
  upload.addEventListener("click", () => files.click());
  files.addEventListener("change", async () => {
    preparing = true;
    controls();
    notice("Preparing images…");
    try {
      if (images.length + files.files.length > 3) throw new Error("Attach up to 3 images at a time.");
      const prepared = await Promise.all(Array.from(files.files, prepare));
      images.push(...prepared);
      renderAttachments();
      notice();
    } catch (error) { notice(error.message, true); }
    finally { files.value = ""; preparing = false; controls(); }
  });

  // ponytail: keep recent context in this tab; add saved conversations only if requested.
  function contextFor(next) {
    const recent = [...history, next].slice(-21);
    let count = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      recent[i] = { ...recent[i], content: recent[i].content.map(part => {
        if (part.type !== "image_url" || ++count <= 3) return part;
        return { type: "text", text: "[Earlier image omitted]" };
      }) };
    }
    const length = () => recent.reduce((sum, item) => sum + item.content.reduce((n, part) => n + (part.text?.length || 0), 0), 0);
    while (recent.length > 1 && length() > 24000) recent.shift();
    while (recent[0]?.role === "assistant") recent.shift();
    return recent;
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (controller || preparing) return;
    const text = input.value.trim();
    if (!text && !images.length) { input.focus(); return; }
    const content = [{ type: "text", text: text || "Please describe this image." }, ...images.map(image => ({ type: "image_url", image_url: { url: image.url } }))];
    const next = { role: "user", content };
    const pending = addMessage("user", content);
    controller = new AbortController();
    controls();
    notice("Thinking…");
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: contextFor(next) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(70000)]),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Chat is unavailable. Please try again.");
      if (typeof data.message !== "string") throw new Error("No answer was returned. Please try again.");
      const answer = { role: "assistant", content: [{ type: "text", text: data.message }] };
      history = [...contextFor(next), answer];
      addMessage("assistant", answer.content);
      input.value = "";
      images = [];
      renderAttachments();
      notice(data.truncated ? "Answer reached its length limit. Ask me to continue." : "Remembers recent messages and the last 3 images.");
    } catch (error) {
      pending.remove();
      welcome.hidden = history.length > 0;
      notice(controller.signal.aborted ? "Stopped. Your message and images are ready to send again." : error.message, !controller.signal.aborted);
    } finally { controller = undefined; controls(); input.focus(); }
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  stop.addEventListener("click", () => controller?.abort());
  reset.addEventListener("click", () => {
    history = [];
    images = [];
    messages.replaceChildren(welcome);
    welcome.hidden = false;
    input.value = "";
    renderAttachments();
    notice();
    input.focus();
  });
})();
