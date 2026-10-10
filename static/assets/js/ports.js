(() => {
  const games = [
    { name: "BO1 Zombies", url: "https://vel.gg/bo1z", image: "/assets/media/ports/bo1.svg", note: "Zombies · Fan port" },
    { name: "Black Ops 2", url: "https://vibeslops.luckeysystems.com/", image: "/assets/media/ports/bo2.svg", note: "Availability unverified" },
    { name: "Modern Warfare 2", url: "https://ovz-game-production.up.railway.app/", image: "/assets/media/ports/mw2.svg", note: "Availability unverified" },
    { name: "Skate 3", url: "https://skate.aaddpp.lol/", image: "/assets/media/ports/skate3.svg", note: "Own game files required" },
    { name: "Skate Rust", url: "https://global-terror.net/", image: "/assets/media/ports/skate-rust.svg", note: "Availability unverified" },
    { name: "CS Surf", url: "https://surfd.net/", image: "/assets/media/ports/cs-surf.svg", note: "Availability unverified" },
    { name: "Halo CE", url: "https://mitchellhynes.com/halo/", image: "/assets/media/ports/halo.svg", note: "Combat Evolved · Browser port" },
    { name: "Halo CE Mobile", url: "https://hcemobile.com/", image: "/assets/media/ports/halo-mobile.svg", note: "Availability unverified" },
    { name: "PES 6", url: "https://pes6.optijuegos.net/", image: "/assets/media/ports/pes6.svg", note: "Football · Keyboard & gamepad" },
    { name: "GTA 5", url: "https://web.archive.org/web/20261005232456/https://playgta5.com/", image: "/assets/media/ports/gta5.svg", note: "Archived page · May be incomplete" },
    { name: "GTA Vice City", url: "https://joncodeofficial.github.io/gta-vice-city-wasm/", image: "/assets/media/ports/vice-city.svg", note: "Own game files required" },
    { name: "The Simpsons: Hit & Run", url: "https://shar-wasm.cjoseph.workers.dev/?skipmovie", image: "/assets/media/ports/simpsons.svg", note: "Driving · Fan port" },
    { name: "Quake 1", url: "https://q1.pieter.com/", image: "/assets/media/ports/quake1.svg", note: "QuakeWorld · Multiplayer" },
    { name: "Quake 2", url: "https://q2.pieter.com/", image: "/assets/media/ports/quake2.svg", note: "Arena shooter · Multiplayer" },
    { name: "Quake 3", url: "https://q3.pieter.com/", image: "/assets/media/ports/quake3.svg", note: "Arena shooter · Multiplayer" },
    { name: "Return to Castle Wolfenstein", url: "https://rtcw.pieter.com/", image: "/assets/media/ports/rtcw.svg", note: "Multiplayer · Large first load" },
    { name: "Urban Terror", url: "https://ut.pieter.com/", image: "/assets/media/ports/urban-terror.svg", note: "Listed as Unreal Tournament in your links" },
    { name: "Half-Life", url: "https://pixelsuft.github.io/hl/", image: "/assets/media/ports/half-life.svg", note: "Classic FPS · Xash3D" },
    { name: "Half-Life / CS 1.6", url: "https://x8bitrain.github.io/webXash/", image: "/assets/media/ports/webxash.svg", note: "Classic FPS · WebXash" },
    { name: "Diablo", url: "https://johnimril.github.io/diablo_web/", image: "/assets/media/ports/diablo.svg", note: "Action RPG · Browser port" },
    { name: "Hedgewars", url: "https://webwars.link/", image: "/assets/media/ports/hedgewars.svg", note: "Availability unverified" },
    { name: "More GTA / Minecraft", url: "https://wasmarcade.com/", image: "/assets/media/ports/wasm-arcade.svg", note: "WASM Arcade · Game collection" },
  ];
  const grid = document.getElementById("ports-grid");
  const search = document.getElementById("ports-search");
  const count = document.getElementById("ports-count");
  const empty = document.getElementById("ports-empty");

  const cards = games.map(game => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "port-card";
    card.setAttribute("aria-label", `Open ${game.name} inside Interstellar`);
    const image = document.createElement("img");
    image.src = game.image;
    image.alt = "";
    image.width = 300;
    image.height = 200;
    image.loading = "lazy";
    const info = document.createElement("span");
    info.className = "port-info";
    const name = document.createElement("span");
    name.className = "port-name";
    name.textContent = game.name;
    const note = document.createElement("span");
    note.className = "port-note";
    note.textContent = game.note;
    const open = document.createElement("span");
    open.className = "port-open";
    open.textContent = "Open game →";
    info.append(name, note, open);
    card.append(image, info);
    card.addEventListener("click", () => go(game.url));
    grid.append(card);
    return { card, terms: `${game.name} ${game.note}`.toLowerCase() };
  });
  function filterGames() {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const { card, terms } of cards) {
      card.hidden = !terms.includes(query);
      if (!card.hidden) visible++;
    }
    count.textContent = `${visible} of ${games.length} games`;
    empty.hidden = visible !== 0;
  }
  search.addEventListener("input", filterGames);
  filterGames();
})();
