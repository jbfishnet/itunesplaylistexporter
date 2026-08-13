/** A single shared <audio> + mini-player bar, reused by every tab's play
 * buttons — only one thing can be playing at a time anyway, so one player
 * avoids each tab needing its own audio element and state.
 *
 * Every per-row play button calls toggle(url, label): clicking the button
 * for whatever's currently playing stops it; clicking any other one starts
 * that track instead. sync() repaints every "[data-play-url]" button's icon
 * to match reality — called after every table re-render (so a row that
 * happens to match the currently-playing url shows ⏸ immediately) and after
 * every play/pause/stop (so, e.g., the mini-player's own controls or the
 * track ending keep the row buttons honest too). */
(() => {
  const audio = new Audio();
  audio.preload = "none";

  const bar = document.createElement("div");
  bar.className = "player-bar";
  bar.innerHTML = `
    <button type="button" class="player-toggle" id="plePlayerToggle">▶</button>
    <span class="player-label" id="plePlayerLabel"></span>
    <button type="button" class="player-close" id="plePlayerClose">✕</button>
  `;
  document.body.appendChild(bar);

  const toggleBtn = bar.querySelector("#plePlayerToggle");
  const labelEl = bar.querySelector("#plePlayerLabel");
  const closeBtn = bar.querySelector("#plePlayerClose");

  let currentUrl = null;
  let currentLabel = "";

  function sync() {
    const isPlaying = currentUrl && !audio.paused;
    toggleBtn.textContent = isPlaying ? "⏸" : "▶";
    document.querySelectorAll(".play-btn[data-play-url]").forEach((btn) => {
      const active = btn.dataset.playUrl === currentUrl && isPlaying;
      btn.textContent = active ? "⏸" : "▶";
      btn.classList.toggle("playing", active);
    });
  }

  function stop() {
    audio.pause();
    audio.removeAttribute("src");
    currentUrl = null;
    bar.classList.remove("open", "player-error");
    sync();
  }

  function play(url, label) {
    currentUrl = url;
    currentLabel = label || "";
    labelEl.textContent = `Playing "${currentLabel}"…`;
    bar.classList.add("open");
    bar.classList.remove("player-error");
    audio.src = url;
    audio.play().catch((err) => {
      labelEl.textContent = `Couldn't play "${currentLabel}" — ${err.message}`;
      bar.classList.add("player-error");
    });
    sync();
  }

  /** What every row's play button calls: a second click on the track that's
   * already playing stops it instead of restarting it. */
  function toggle(url, label) {
    if (currentUrl === url && !audio.paused) {
      stop();
    } else {
      play(url, label);
    }
  }

  toggleBtn.addEventListener("click", () => {
    if (!currentUrl) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  closeBtn.addEventListener("click", stop);

  audio.addEventListener("play", sync);
  audio.addEventListener("pause", sync);
  audio.addEventListener("ended", stop);
  audio.addEventListener("error", () => {
    labelEl.textContent = `Couldn't play "${currentLabel}" — the file may be unreadable.`;
    bar.classList.add("player-error");
    sync();
  });

  window.PlaylistExporterAudio = { toggle, stop, sync };
})();
