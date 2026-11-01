(() => {
  const buildTimeEl = document.getElementById("releaseBuildTime");
  const notesEl = document.getElementById("releaseNotesContent");

  async function loadReleaseNotes() {
    try {
      const [notesResponse, infoResponse] = await Promise.all([
        fetch("/api/release-notes"),
        fetch("/api/app-info"),
      ]);
      const notes = await notesResponse.json();
      const info = await infoResponse.json();
      if (!notesResponse.ok) throw new Error(notes.error || "Couldn't load release notes");
      if (!infoResponse.ok) throw new Error(info.error || "Couldn't load build information");

      buildTimeEl.textContent = info.buildTime
        ? `Version ${info.version} · Built ${new Date(info.buildTime).toLocaleString()} (${info.buildTime})`
        : `Version ${info.version} · Build time unavailable for this development build`;
      notesEl.replaceChildren();
      for (const release of notes.releases || []) {
        const section = document.createElement("section");
        section.className = "release-entry";
        const heading = document.createElement("h3");
        heading.textContent = `Version ${release.version}`;
        const date = document.createElement("p");
        date.className = "library-meta";
        date.textContent = release.date || "";
        const list = document.createElement("ul");
        for (const change of release.changes || []) {
          const item = document.createElement("li");
          item.textContent = change;
          list.append(item);
        }
        section.append(heading, date, list);
        notesEl.append(section);
      }
    } catch (err) {
      buildTimeEl.textContent = err.message;
    }
  }

  document.addEventListener("ple:tab-activated", (event) => {
    if (event.detail.tabName === "releaseNotes") loadReleaseNotes();
  });
})();
