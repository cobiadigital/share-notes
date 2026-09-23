function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// JSON embedded in a <script> must not be able to close the tag.
function safeJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function renderPage(key: string, note: { content: string; version: number } | null): string {
  const title = key === "" ? "/" : key;
  const initial = { key, content: note?.content ?? "", version: note?.version ?? 0 };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #fbfaf8; --fg: #1d1d1f; --muted: #8a8a8e; --bar: #f1efeb; --border: #e2dfd9;
    --ok: #2e7d32; --warn: #b26a00; --err: #c62828; --accent: #2f5fd0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161618; --fg: #e8e8ea; --muted: #8e8e93; --bar: #1f1f22; --border: #2c2c30;
      --ok: #81c784; --warn: #ffb74d; --err: #ef9a9a; --accent: #8fb0ff;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); }
  body {
    display: flex; flex-direction: column; height: 100dvh;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 16px; padding-top: max(8px, env(safe-area-inset-top));
    background: var(--bar); border-bottom: 1px solid var(--border);
  }
  #name {
    flex: 1; min-width: 0; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #status { color: var(--muted); font-size: 13px; white-space: nowrap; }
  #status.ok { color: var(--ok); }
  #status.warn { color: var(--warn); }
  #status.err { color: var(--err); }
  #conflict {
    display: none; gap: 8px; align-items: center; flex-wrap: wrap;
    padding: 8px 16px; background: var(--bar); border-bottom: 1px solid var(--border); font-size: 14px;
  }
  #conflict.show { display: flex; }
  #conflict span { flex: 1; min-width: 12em; }
  button {
    font: inherit; font-size: 14px; padding: 4px 12px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--bg); color: var(--accent); cursor: pointer;
  }
  textarea {
    flex: 1; width: 100%; resize: none; border: 0; outline: none;
    padding: 16px; padding-bottom: max(16px, env(safe-area-inset-bottom));
    background: transparent; color: inherit; tab-size: 4;
    /* 16px keeps iOS Safari from zooming on focus */
    font: 16px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  textarea::placeholder { color: var(--muted); }
</style>
</head>
<body>
<header>
  <div id="name">${escapeHtml(title)}</div>
  <div id="status"></div>
</header>
<div id="conflict">
  <span>This note was changed on another device.</span>
  <button id="useTheirs" type="button">Load theirs</button>
  <button id="keepMine" type="button">Keep mine</button>
</div>
<textarea id="text" spellcheck="true" autocapitalize="sentences" placeholder="Start typing. Saves automatically."></textarea>
<script>
(() => {
  const initial = ${safeJson(initial)};
  const endpoint = location.pathname;
  const draftKey = "draft:" + initial.key;
  const ta = document.getElementById("text");
  const statusEl = document.getElementById("status");
  const conflictEl = document.getElementById("conflict");

  let version = initial.version;
  let saved = initial.content;   // what the server has at "version"
  let inflight = false;
  let saveTimer = null;
  let retryDelay = 2000;
  let conflict = null;           // server copy when we hit a conflict

  const dirty = () => ta.value !== saved;
  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ""; }

  function storeDraft() {
    try {
      if (dirty()) localStorage.setItem(draftKey, JSON.stringify({ content: ta.value, baseVersion: version }));
      else localStorage.removeItem(draftKey);
    } catch {}
  }

  // Replace the text without losing the caret more than necessary.
  function replaceText(content) {
    const { selectionStart: s, selectionEnd: e } = ta;
    const focused = document.activeElement === ta;
    ta.value = content;
    if (focused) ta.setSelectionRange(Math.min(s, content.length), Math.min(e, content.length));
  }

  function showConflict(server) {
    conflict = server;
    conflictEl.classList.add("show");
    setStatus("Conflict", "err");
  }
  function clearConflict() { conflict = null; conflictEl.classList.remove("show"); }

  function scheduleSave(delay) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, delay);
  }

  async function save(force) {
    if (inflight || (!dirty() && !force)) return;
    if (conflict && !force) return;
    inflight = true;
    let failed = false;
    const content = ta.value;
    setStatus("Saving…");
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, baseVersion: version, force: !!force }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        showConflict(data);
      } else if (!res.ok) {
        throw new Error(data.error || res.status);
      } else {
        version = data.version;
        saved = content;
        retryDelay = 2000;
        clearConflict();
        setStatus(dirty() ? "Editing…" : "Saved", dirty() ? "" : "ok");
      }
    } catch (err) {
      failed = true;
      setStatus("Offline, retrying", "warn");
      scheduleSave(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    } finally {
      inflight = false;
      storeDraft();
      if (dirty() && !conflict && !failed) scheduleSave(800);
    }
  }

  async function refresh() {
    if (inflight || dirty() || conflict || document.hidden) return;
    try {
      const res = await fetch(endpoint + "?json", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.version !== version && !dirty() && !inflight) {
        version = data.version;
        saved = data.content;
        replaceText(data.content);
        setStatus("Updated", "ok");
      }
    } catch {}
  }

  ta.addEventListener("input", () => {
    setStatus("Editing…");
    storeDraft();
    scheduleSave(700);
  });

  // Tab inserts a tab instead of leaving the textarea.
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "\\t");
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
  });

  document.getElementById("useTheirs").addEventListener("click", () => {
    version = conflict.version;
    saved = conflict.content;
    replaceText(conflict.content);
    clearConflict();
    storeDraft();
    setStatus("Loaded latest", "ok");
  });
  document.getElementById("keepMine").addEventListener("click", () => {
    clearConflict();
    save(true);
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  window.addEventListener("focus", refresh);
  setInterval(refresh, 10000);

  // Last-chance save when the tab is closed or backgrounded.
  window.addEventListener("pagehide", () => {
    if (!dirty() || conflict) return;
    const blob = new Blob([JSON.stringify({ content: ta.value, baseVersion: version })], { type: "application/json" });
    navigator.sendBeacon(endpoint, blob);
  });
  window.addEventListener("beforeunload", (e) => { if (dirty() || inflight) e.preventDefault(); });

  // Start: server content, or an unsaved local draft from a previous visit.
  ta.value = initial.content;
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(draftKey) || "null"); } catch {}
  if (draft && draft.content !== initial.content) {
    ta.value = draft.content;
    if (draft.baseVersion === version) { setStatus("Restoring draft…"); save(); }
    else showConflict({ content: initial.content, version });
  } else {
    try { localStorage.removeItem(draftKey); } catch {}
    setStatus(version ? "Saved" : "New note", version ? "ok" : "");
  }
  if (!ta.value) ta.focus();
})();
</script>
</body>
</html>`;
}
