(() => {
  const status = document.getElementById("pc-status");
  const account = document.getElementById("pc-account");
  const userLabel = document.getElementById("pc-user");
  const auth = document.getElementById("pc-auth");
  const authForm = document.getElementById("pc-auth-form");
  const username = document.getElementById("pc-username");
  const password = document.getElementById("pc-password");
  const login = document.getElementById("pc-login");
  const signup = document.getElementById("pc-signup");
  const home = document.getElementById("pc-home");
  const info = document.getElementById("pc-save-info");
  const start = document.getElementById("pc-start");
  const startLabel = document.getElementById("pc-start-label");
  const deleteButton = document.getElementById("pc-delete");
  const logout = document.getElementById("pc-logout");
  const machine = document.getElementById("pc-machine");
  const screen = document.getElementById("pc-screen");
  const cad = document.getElementById("pc-cad");
  const fullscreen = document.getElementById("pc-fullscreen");
  const stop = document.getElementById("pc-stop");
  const restart = document.getElementById("pc-restart");
  const reconnect = document.getElementById("pc-reconnect");
  const desktopButton = document.getElementById("pc-desktop");
  const quality = document.getElementById("pc-quality");
  const connection = document.getElementById("pc-connection");
  const upload = document.getElementById("pc-upload");
  const fileInput = document.getElementById("pc-file");
  const transfer = document.getElementById("pc-transfer");
  const confirmation = document.getElementById("pc-confirm");
  const confirmationMessage = document.getElementById("pc-confirm-message");
  const confirmationAccept = document.getElementById("pc-confirm-accept");
  const client = crypto.randomUUID();
  let me, lease, rfb, timer, homeTimer, handshake, uploading, busy = false, connecting = false, polling = false, restarting = false, failures = 0;

  function notice(text = "", error = false) { status.textContent = text; status.dataset.error = String(error); }
  function connectionNotice(text) { connection.textContent = text; connection.hidden = !text; if (text) notice(text); }
  function schedule(delay = 2000) { clearTimeout(timer); if (lease) timer = setTimeout(heartbeat, delay); }
  async function confirmAction(message, label) {
    if (confirmation.open) return false;
    confirmationMessage.textContent = message; confirmationAccept.textContent = label;
    confirmation.returnValue = "cancel";
    const result = new Promise(resolve => confirmation.addEventListener("close", () => resolve(confirmation.returnValue === "ok"), { once: true }));
    confirmation.showModal();
    return result;
  }
  function show() {
    account.hidden = !me;
    userLabel.textContent = me ? `Signed in as ${me.username}` : "";
    auth.hidden = !!me;
    home.hidden = !me || !!lease;
    machine.hidden = !lease;
    if (!lease && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    info.textContent = me?.deleting ? (me.deletionRetrying ? "Deletion is taking longer than expected. Retrying automatically; your replacement PC will be available after cleanup finishes." : "Permanently deleting your PC and its files. This may take a few minutes. You can close this page; deletion will continue.") : me?.assigned ? "Your saved files stay on this PC. You can delete it to start over with a fresh Windows PC." : "Create your own Windows PC, while capacity is available. Each account can have one PC at a time. Your files stay separate from other accounts.";
    startLabel.textContent = me?.deleting ? "Deleting PC…" : me?.assigned ? "Start my PC" : "Create my PC";
    start.disabled = busy || !!me?.deleting;
    deleteButton.hidden = !me?.assigned;
    deleteButton.disabled = busy || !!me?.deleting;
  }
  function setBusy(value) { busy = value; for (const button of [login, signup, logout]) button.disabled = value; show(); }
  async function api(action, body) {
    const response = await fetch(`/api/pc/${action}`, {
      credentials: "same-origin", signal: AbortSignal.timeout(25000),
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || "Please try again."); error.status = response.status; error.code = result.code; throw error; }
    return result;
  }
  async function refresh() {
    clearTimeout(homeTimer);
    const wasDeleting = me?.deleting;
    try {
      me = await api("me");
      if (wasDeleting && !me.deleting && !me.assigned) notice("Your PC was deleted. Your account is still here. Choose Create my PC for a fresh Windows installation.");
    } catch (error) { if (error.status === 401) me = null; else notice(error.message, true); }
    show();
    if (me?.deleting) homeTimer = setTimeout(refresh, 5000);
  }
  async function authenticate(action) {
    if (busy || !authForm.reportValidity()) return;
    setBusy(true);
    try { await api(action, { username: username.value, password: password.value }); password.value = ""; notice(); await refresh(); }
    catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  }
  function disconnect(close = true) {
    clearTimeout(handshake);
    const desktop = rfb;
    rfb = null;
    connecting = false;
    if (close) desktop?.disconnect();
    screen.replaceChildren();
  }
  async function release() {
    const previous = lease;
    lease = null;
    clearTimeout(timer);
    uploading?.abort();
    disconnect();
    show();
    if (previous) {
      try { await api("release", { lease: previous }); notice("Your PC is shutting down. Saved files will be here next time."); }
      catch { notice("Disconnected. Your PC will shut down when the connection timeout expires."); }
    }
  }
  async function connectDesktop(current) {
    if (rfb || connecting || restarting || lease !== current) return;
    connecting = true;
    try {
      const { default: RFB } = await import("/pc-rfb.mjs");
      if (lease !== current || restarting) return;
      connectionNotice("Connecting to Windows…");
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/pc/desktop?lease=${encodeURIComponent(current)}`;
      const desktop = new RFB(screen, url);
      rfb = desktop;
      desktop.scaleViewport = true;
      desktop.clipViewport = false;
      desktop.resizeSession = true;
      desktop.showDotCursor = true;
      desktop.qualityLevel = Number(quality.value);
      desktop.compressionLevel = 2;
      desktop.background = "#000";
      handshake = setTimeout(() => {
        if (rfb !== desktop) return;
        disconnect(); connectionNotice("Connection stalled. Reconnecting…"); schedule();
      }, 25000);
      desktop.addEventListener("connect", () => {
        if (rfb !== desktop) return;
        clearTimeout(handshake); failures = 0; connectionNotice("");
        notice("Connected to Windows. Save your work before closing this tab.");
      });
      desktop.addEventListener("disconnect", () => {
        if (rfb !== desktop) return;
        disconnect(false);
        if (lease) { connectionNotice("Connection lost. Reconnecting to your PC…"); schedule(); }
      });
      desktop.addEventListener("securityfailure", () => notice("Windows rejected the desktop connection. Contact the site owner.", true));
    } finally { connecting = false; }
  }
  async function heartbeat() {
    const current = lease;
    if (!current || polling) return;
    polling = true;
    try {
      const result = await api("heartbeat", { lease: current });
      if (lease !== current) return;
      failures = 0;
      if (result.ready) await connectDesktop(current);
      else connectionNotice(result.provisioning ? "Creating your personal Windows PC. First-time setup can take 10–20 minutes…" : result.restarting ? "Windows is restarting. Reconnecting automatically…" : "Windows is starting. This can take a few minutes…");
    } catch (error) {
      if (lease !== current) return;
      if (error.code === "PC_DELETING") { lease = null; uploading?.abort(); disconnect(); await refresh(); return; }
      failures++;
      if ([401,409].includes(error.status) || failures >= 4) {
        await release();
        if (error.status === 401) { me = null; show(); }
        notice(error.message, true); return;
      }
      connectionNotice("Waiting for your connection. Retrying automatically…");
    } finally { polling = false; if (lease === current) schedule(rfb ? 20000 : 3000); }
  }
  async function powerOn() {
    if (busy || lease || me?.deleting) return;
    setBusy(true);
    notice("Starting your Windows PC…");
    try {
      const deadline = Date.now() + 300000;
      for (;;) {
        try { const result = await api("start", { client }); lease = result.lease; me.pcId = result.pcId; break; }
        catch (error) {
          if (error.code !== "PC_STOPPING" || Date.now() >= deadline) throw error;
          notice("Finishing the previous shutdown. Windows will start automatically…");
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }
      me.assigned = true; connectionNotice("Starting Windows…"); show(); heartbeat();
    }
    catch (error) { notice(error.message, true); if (error.code === "PC_DELETING") await refresh(); }
    finally { setBusy(false); }
  }
  authForm.addEventListener("submit", event => { event.preventDefault(); authenticate("login"); });
  signup.addEventListener("click", () => authenticate("signup"));
  start.addEventListener("click", powerOn);
  deleteButton.addEventListener("click", async () => {
    if (busy || !me?.pcId || me.deleting) return;
    const pcId = me.pcId;
    if (!await confirmAction("Are you sure you want to permanently delete your PC? All files, installed apps, and settings on it will be erased and cannot be recovered. Your account stays. After deletion finishes, you can create one new PC.", "Delete permanently")) return;
    if (busy || me?.pcId !== pcId || me.deleting) return;
    setBusy(true);
    try {
      const result = await api("delete", { pcId, confirm: true });
      lease = null; clearTimeout(timer); uploading?.abort(); disconnect();
      me.deleting = result.deleting;
      notice("Deleting your PC. You can create a fresh one after deletion finishes.");
      await refresh();
    } catch (error) { notice(error.message, true); await refresh(); }
    finally { setBusy(false); }
  });
  stop.addEventListener("click", async () => { if (await confirmAction("Save your work in Windows first. Shut down this PC now?", "Shut down")) release(); });
  reconnect.addEventListener("click", () => { disconnect(); connectionNotice("Reconnecting to Windows…"); schedule(0); });
  restart.addEventListener("click", async () => {
    if (!lease || restarting || !await confirmAction("Save your work in Windows first. Restart this PC now?", "Restart")) return;
    if (!lease || restarting) return;
    restarting = true; restart.disabled = true;
    disconnect(); connectionNotice("Restarting Windows…");
    try { await api("restart", { lease }); }
    catch (error) { notice(error.message, true); }
    finally { restarting = false; restart.disabled = !!uploading; schedule(0); }
  });
  desktopButton.addEventListener("click", () => {
    if (!rfb) return;
    rfb.sendKey(0xffeb, "MetaLeft", true); rfb.sendKey(0x64, "KeyD"); rfb.sendKey(0xffeb, "MetaLeft", false); rfb.focus();
  });
  quality.addEventListener("change", () => { if (rfb) rfb.qualityLevel = Number(quality.value); });
  upload.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0]; fileInput.value = "";
    if (!file || !lease || uploading) return;
    if (!file.size || file.size > 50 * 1024 * 1024) { transfer.textContent = "Choose a file between 1 byte and 50 MB."; return; }
    const xhr = new XMLHttpRequest(); uploading = xhr;
    upload.disabled = restart.disabled = true;
    xhr.open("POST", "/api/pc/upload"); xhr.timeout = 120000;
    xhr.setRequestHeader("X-Lease", lease); xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    transfer.textContent = `Uploading ${file.name}…`;
    xhr.upload.onprogress = event => { if (event.lengthComputable) transfer.textContent = `Uploading ${file.name}: ${Math.round(event.loaded / event.total * 100)}%`; };
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        transfer.textContent = xhr.status === 200 ? `${result.name} is in Windows Downloads. Open it there when you're ready.` : result.error;
      } catch { transfer.textContent = "Upload failed. Please try again."; }
    };
    xhr.onerror = xhr.ontimeout = () => { transfer.textContent = "Upload interrupted. Check your connection and try again."; };
    xhr.onabort = () => { transfer.textContent = "Upload cancelled."; };
    xhr.onloadend = () => { uploading = null; upload.disabled = false; restart.disabled = restarting; };
    xhr.send(file);
  });
  cad.addEventListener("click", () => rfb?.sendCtrlAltDel());
  fullscreen.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    // noVNC's fallback pointer is attached to body, outside the desktop container.
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreen.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
    rfb?.focus();
  });
  logout.addEventListener("click", async () => {
    if (lease && !await confirmAction("Save your work in Windows first. Sign out and shut down your PC?", "Sign out")) return;
    await release();
    try { await api("logout", {}); me = null; show(); notice("Signed out."); } catch (error) { notice(error.message, true); }
  });
  addEventListener("pagehide", () => {
    if (lease) navigator.sendBeacon("/api/pc/release", new Blob([JSON.stringify({ lease })], { type: "application/json" }));
    lease = null; disconnect();
    clearTimeout(timer); clearTimeout(homeTimer); uploading?.abort();
  });
  addEventListener("online", () => schedule(0));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(0); });
  addEventListener("pageshow", event => { if (event.persisted) refresh(); });
  refresh();
})();
