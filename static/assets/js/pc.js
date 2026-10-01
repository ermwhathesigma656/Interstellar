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
  const client = crypto.randomUUID();
  let me, lease, rfb, timer, handshake, uploading, busy = false, connecting = false, polling = false, restarting = false, failures = 0;

  function notice(text = "", error = false) { status.textContent = text; status.dataset.error = String(error); }
  function connectionNotice(text) { connection.textContent = text; connection.hidden = !text; if (text) notice(text); }
  function schedule(delay = 2000) { clearTimeout(timer); if (lease) timer = setTimeout(heartbeat, delay); }
  function show() {
    account.hidden = !me;
    userLabel.textContent = me ? `Signed in as ${me.username}` : "";
    auth.hidden = !!me;
    home.hidden = !me || !!lease;
    machine.hidden = !lease;
    info.textContent = me?.assigned ? "Your saved files stay on this PC. Start Windows when you are ready." : "Start to claim your own Windows PC, while PCs are available. Your files stay separate from other accounts.";
  }
  function setBusy(value) { busy = value; for (const button of [login, signup, start, logout]) button.disabled = value; }
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
    try { me = await api("me"); } catch (error) { me = null; if (error.status !== 401) notice(error.message, true); }
    show();
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
    if (busy || lease) return;
    setBusy(true);
    notice("Starting your Windows PC…");
    try {
      const deadline = Date.now() + 300000;
      for (;;) {
        try { lease = (await api("start", { client })).lease; break; }
        catch (error) {
          if (error.code !== "PC_STOPPING" || Date.now() >= deadline) throw error;
          notice("Finishing the previous shutdown. Windows will start automatically…");
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }
      me.assigned = true; connectionNotice("Starting Windows…"); show(); heartbeat();
    }
    catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  }
  authForm.addEventListener("submit", event => { event.preventDefault(); authenticate("login"); });
  signup.addEventListener("click", () => authenticate("signup"));
  start.addEventListener("click", powerOn);
  stop.addEventListener("click", () => { if (confirm("Save your work in Windows first. Shut down this PC now?")) release(); });
  reconnect.addEventListener("click", () => { disconnect(); connectionNotice("Reconnecting to Windows…"); schedule(0); });
  restart.addEventListener("click", async () => {
    if (!lease || restarting || !confirm("Save your work in Windows first. Restart this PC now?")) return;
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
    else machine.requestFullscreen().catch(() => {});
  });
  logout.addEventListener("click", async () => {
    if (lease && !confirm("Save your work in Windows first. Sign out and shut down your PC?")) return;
    await release();
    try { await api("logout", {}); me = null; show(); notice("Signed out."); } catch (error) { notice(error.message, true); }
  });
  addEventListener("pagehide", () => {
    if (lease) navigator.sendBeacon("/api/pc/release", new Blob([JSON.stringify({ lease })], { type: "application/json" }));
    lease = null; disconnect();
    clearTimeout(timer); uploading?.abort();
  });
  addEventListener("online", () => schedule(0));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(0); });
  addEventListener("pageshow", event => { if (event.persisted) refresh(); });
  refresh();
})();
