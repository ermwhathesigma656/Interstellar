// This game needs shared memory in an isolated top-level page, outside the proxy tabs.
export function gta5Page() {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GTA V · Interstellar</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #111; color: #eee; font: 14px system-ui, sans-serif; height: 100dvh; display: flex; flex-direction: column; }
    header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; flex-wrap: wrap; }
    h1 { font-size: 16px; margin: 0; flex: 1; }
    a, button, select { color: inherit; background: #292929; border: 1px solid #555; border-radius: 8px; padding: 8px 12px; font: inherit; text-decoration: none; cursor: pointer; }
    a:hover, button:hover { background: #393939; }
    a:focus-visible, button:focus-visible, select:focus-visible { outline: 2px solid #a9ceff; outline-offset: 2px; }
    button:disabled { opacity: .45; cursor: default; }
    #graphics { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    iframe { border: 0; width: 100%; flex: 1; min-height: 0; background: #000; }
    #status { margin: 0; padding: 0 16px 8px; color: #ccc; }
    #status:empty { display: none; }
  </style>
</head>
<body>
  <header>
    <a href="/play.html">← Games</a>
    <h1>GTA V</h1>
    <form id="graphics">
      <label for="quality">Graphics</label>
      <select id="quality">
        <option value="performance">Performance · 540p</option>
        <option value="balanced" selected>Balanced · 720p</option>
        <option value="sharp">Sharp · 900p</option>
      </select>
      <button id="apply" type="submit" disabled>Apply &amp; restart</button>
    </form>
    <button id="fullscreen" type="button">Fullscreen</button>
  </header>
  <p id="hint" style="margin:0;padding:0 16px 8px;color:#bbb">Press = inside the game to show FPS. Try Performance if play feels slow.</p>
  <p id="status" role="status"></p>
  <iframe id="game" title="GTA V browser game" allow="cross-origin-isolated; fullscreen; autoplay; gamepad" referrerpolicy="no-referrer" allowfullscreen></iframe>
  <script>
    const profiles = { performance: '960x540', balanced: '1280x720', sharp: '1600x900' };
    const quality = document.getElementById('quality');
    const apply = document.getElementById('apply');
    const game = document.getElementById('game');
    let active = 'balanced';
    try {
      const saved = localStorage.getItem('gta5.graphics');
      if (Object.hasOwn(profiles, saved)) active = saved;
    } catch {}
    quality.value = active;
    function startGame() {
      const url = new URL('https://interstellar-gta5.gonicvrnew.workers.dev/');
      url.search = new URLSearchParams({ low: '1', fps: '60', res: profiles[active] });
      game.src = url.href;
      apply.disabled = true;
    }
    quality.addEventListener('change', () => { apply.disabled = quality.value === active; });
    document.getElementById('graphics').addEventListener('submit', event => {
      event.preventDefault();
      if (!Object.hasOwn(profiles, quality.value) || quality.value === active) return;
      if (!confirm('Restart the game to apply these graphics settings? Save in the game first. Unsaved progress will be lost.')) return;
      active = quality.value;
      try { localStorage.setItem('gta5.graphics', active); } catch {}
      startGame();
    });
    startGame();
    document.getElementById('fullscreen').addEventListener('click', async () => {
      try {
        await game.requestFullscreen();
        document.getElementById('status').textContent = '';
      } catch {
        document.getElementById('status').textContent = 'Fullscreen is unavailable in this browser. You can keep playing here.';
      }
    });
  </script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Permissions-Policy": 'cross-origin-isolated=(self "https://interstellar-gta5.gonicvrnew.workers.dev")',
      "Content-Security-Policy": "frame-ancestors 'none'; frame-src https://interstellar-gta5.gonicvrnew.workers.dev",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
