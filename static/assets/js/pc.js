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
  const claimForm = document.getElementById("pc-claim-form");
  const code = document.getElementById("pc-code");
  const claim = document.getElementById("pc-claim");
  const start = document.getElementById("pc-start");
  const logout = document.getElementById("pc-logout");
  const machine = document.getElementById("pc-machine");
  const screen = document.getElementById("pc-screen");
  const cad = document.getElementById("pc-cad");
  const fullscreen = document.getElementById("pc-fullscreen");
  const stop = document.getElementById("pc-stop");
  const client = crypto.randomUUID();
  let me, lease, rfb, timer, busy = false, connecting = false, failures = 0;

  function notice(text = "", error = false) { status.textContent = text; status.dataset.error = String(error); }
  function show() {
    account.hidden = !me;
    userLabel.textContent = me ? `Signed in as ${me.username}` : "";
    auth.hidden = !!me;
    home.hidden = !me || !!lease;
    machine.hidden = !lease;
    claimForm.hidden = !!me?.assigned;
    start.hidden = !me?.assigned;
    info.textContent = me?.assigned ? "Your saved files stay on this PC. Start Windows when you are ready." : "Enter the activation code supplied with your PC.";
  }
  function setBusy(value) { busy = value; for (const button of [login, signup, start, logout, claim]) button.disabled = value; }
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
  function disconnect() {
    clearTimeout(timer);
    const desktop = rfb;
    rfb = null;
    connecting = false;
    desktop?.disconnect();
    screen.replaceChildren();
  }
  async function release() {
    const previous = lease;
    lease = null;
    disconnect();
    show();
    if (previous) {
      try { await api("release", { lease: previous }); notice("Your PC is shutting down. Saved files will be here next time."); }
      catch { notice("Disconnected. Your PC will shut down when the connection timeout expires."); }
    }
  }
  async function connectDesktop(current) {
    if (rfb || connecting || lease !== current) return;
    connecting = true;
    try {
      const { default: RFB } = await import("/pc-rfb.mjs");
      if (lease !== current) return;
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/pc/desktop?lease=${encodeURIComponent(current)}`;
      const desktop = new RFB(screen, url);
      rfb = desktop;
      desktop.scaleViewport = true;
      desktop.background = "#000";
      desktop.addEventListener("connect", () => { failures = 0; notice("Connected to Windows. Save your work before closing this tab."); });
      desktop.addEventListener("disconnect", () => {
        if (rfb !== desktop) return;
        rfb = null;
        screen.replaceChildren();
        if (lease) notice("Connection lost. Reconnecting to your PC…");
      });
      desktop.addEventListener("securityfailure", () => notice("Windows rejected the desktop connection. Contact the site owner.", true));
    } finally { connecting = false; }
  }
  async function heartbeat() {
    const current = lease;
    if (!current) return;
    try {
      const result = await api("heartbeat", { lease: current });
      if (lease !== current) return;
      failures = 0;
      if (result.ready) await connectDesktop(current);
      else notice("Windows is starting. This can take a few minutes…");
    } catch (error) {
      if (lease !== current) return;
      failures++;
      if ([401,409].includes(error.status) || failures >= 4) { await release(); notice(error.message, true); return; }
      notice("Waiting for your connection…", true);
    }
    if (lease === current) timer = setTimeout(heartbeat, rfb ? 20000 : 10000);
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
      show(); heartbeat();
    }
    catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  }
  authForm.addEventListener("submit", event => { event.preventDefault(); authenticate("login"); });
  signup.addEventListener("click", () => authenticate("signup"));
  claimForm.addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return; setBusy(true);
    try { await api("claim", { invitation: code.value.trim() }); code.value = ""; notice("Your Windows PC is ready to start."); await refresh(); }
    catch (error) { notice(error.message, true); } finally { setBusy(false); }
  });
  start.addEventListener("click", powerOn);
  stop.addEventListener("click", () => { if (confirm("Save your work in Windows first. Shut down this PC now?")) release(); });
  cad.addEventListener("click", () => rfb?.sendCtrlAltDel());
  fullscreen.addEventListener("click", () => screen.requestFullscreen().catch(() => {}));
  logout.addEventListener("click", async () => {
    if (lease && !confirm("Save your work in Windows first. Sign out and shut down your PC?")) return;
    await release();
    try { await api("logout", {}); me = null; show(); notice("Signed out."); } catch (error) { notice(error.message, true); }
  });
  addEventListener("pagehide", () => {
    if (lease) navigator.sendBeacon("/api/pc/release", new Blob([JSON.stringify({ lease })], { type: "application/json" }));
    lease = null; disconnect();
  });
  addEventListener("pageshow", event => { if (event.persisted) refresh(); });
  refresh();
})();
