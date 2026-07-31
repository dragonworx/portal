// Portal client — vanilla TS-flavoured JS module.
// No build step: served as-is by the Bun server.

const els = {
  crumbs: document.getElementById("crumbs"),
  filter: document.getElementById("filter"),
  statusBox: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  selectAll: document.getElementById("select-all"),
  viewport: document.getElementById("viewport"),
  spacer: document.getElementById("spacer"),
  rows: document.getElementById("rows"),
  empty: document.getElementById("empty"),
  btnUp: document.getElementById("btn-up"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnNewFolder: document.getElementById("btn-newfolder"),
  btnNewFile: document.getElementById("btn-newfile"),
  btnDownload: document.getElementById("btn-download"),
  btnCut: document.getElementById("btn-cut"),
  btnCopy: document.getElementById("btn-copy"),
  btnPaste: document.getElementById("btn-paste"),
  btnClipboardClear: document.getElementById("btn-clipboard-clear"),
  clipboardChip: document.getElementById("clipboard-chip"),
  chipIcon: document.getElementById("chip-icon"),
  chipMode: document.getElementById("chip-mode"),
  chipSummary: document.getElementById("chip-summary"),
  chipFrom: document.getElementById("chip-from"),
  fileInput: document.getElementById("file-input"),
  selSummary: document.getElementById("selection-summary"),
  uploads: document.getElementById("uploads"),
  uploadsList: document.getElementById("uploads-list"),
  uploadsClear: document.getElementById("uploads-clear"),
  dropzone: document.getElementById("dropzone"),
  dropzonePath: document.getElementById("dropzone-path"),
  user: document.getElementById("user"),
  userEmail: document.getElementById("user-email"),
  // Inline text editor (fullscreen modal).
  editorModal: document.getElementById("editor-modal"),
  editorTitle: document.getElementById("editor-title"),
  editorMode: document.getElementById("editor-mode"),
  editorDirty: document.getElementById("editor-dirty"),
  editorWarning: document.getElementById("editor-warning"),
  editorWarningMsg: document.getElementById("editor-warning-msg"),
  editorBody: document.getElementById("editor-body"),
  editorSave: document.getElementById("editor-save"),
  editorCancel: document.getElementById("editor-cancel"),
  // File preview (fullscreen modal).
  previewModal: document.getElementById("preview-modal"),
  previewTitle: document.getElementById("preview-title"),
  previewMeta: document.getElementById("preview-meta"),
  previewBody: document.getElementById("preview-body"),
  previewDownload: document.getElementById("preview-download"),
  previewClose: document.getElementById("preview-close"),
};

const ROW_HEIGHT = 40;
const OVERSCAN = 6;

const state = {
  /** @type {string} */ path: "",
  /** @type {{name:string,type:'dir'|'file',size:number,mtime:number}[]} */ entries: [],
  /** @type {Set<string>} */ selected: new Set(),
  /** @type {string} */ filter: "",
  /** @type {boolean} */ connected: false,
  /** Inline rename state: { name, value } | null. `name` is the original
   *  entry name we're editing; `value` mirrors the live <input> contents so
   *  the virtualised list can recreate the row mid-edit without losing it. */
  /** @type {{name:string,value:string}|null} */ editing: null,
  /** Pending move/copy. `sourcePath` is the folder the items were grabbed
   *  from; `names` is a Set so we can dim source rows in the listing in O(1)
   *  while still iterating in insertion order via a parallel array. */
  /** @type {{mode:'move'|'copy',sourcePath:string,names:string[]}|null} */ clipboard: null,
};

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

function fmtSize(n) {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function fmtTime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

/* -------------------------------------------------------------------------- */
/*  Networking                                                                */
/* -------------------------------------------------------------------------- */

// Read the portal_csrf cookie set by the server at sign-in time and echo it
// back as the X-CSRF-Token header on every state-changing request. Combined
// with the SameSite=Lax session cookie this gives us defence-in-depth CSRF
// protection (double-submit cookie).
function getCsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)portal_csrf=([^;]+)/);
  return m ? m[1] : "";
}

function redirectToLogin() {
  const here = location.pathname + location.search + location.hash;
  location.href = "/login?returnTo=" + encodeURIComponent(here);
}

async function api(path, opts) {
  const init = opts ? { ...opts } : {};
  const method = (init.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const csrf = getCsrfToken();
    if (csrf) {
      init.headers = { ...(init.headers || {}), "x-csrf-token": csrf };
    }
  }
  init.credentials = "same-origin";
  const res = await fetch(path, init);
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res;
}

async function loadMe() {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (res.status === 401) {
      redirectToLogin();
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.authEnabled && data.email && els.user) {
      // textContent — server-supplied email is not interpreted as HTML.
      els.userEmail.textContent = data.email;
      els.userEmail.title = data.email;
      els.user.hidden = false;
    }
  } catch {
    /* ignore — not a fatal error */
  }
}

async function ping() {
  try {
    const res = await fetch("/api/ping", { cache: "no-store" });
    setConnected(res.ok);
  } catch {
    setConnected(false);
  }
}

function setConnected(ok) {
  if (state.connected === ok) return;
  state.connected = ok;
  els.statusBox.classList.toggle("ok", ok);
  els.statusBox.classList.toggle("bad", !ok);
  els.statusText.textContent = ok ? "connected" : "offline";
}

/* -------------------------------------------------------------------------- */
/*  Listing / navigation                                                      */
/* -------------------------------------------------------------------------- */

async function loadPath(path) {
  try {
    const res = await api(`/api/list?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    state.path = data.path;
    state.entries = data.entries;
    state.selected.clear();
    state.editing = null;
    els.filter.value = "";
    state.filter = "";
    renderCrumbs();
    renderList();
    renderSelection();
    renderClipboard();
    setConnected(true);
    // Reflect current path in the URL hash for shareable links / back button.
    const target = "#/" + state.path.split("/").map(encodeURIComponent).join("/");
    if (location.hash !== target && !(state.path === "" && location.hash === "")) {
      history.replaceState(null, "", target);
    }
  } catch (err) {
    setConnected(false);
    alert(`Failed to load: ${err.message}`);
  }
}

function renderCrumbs() {
  const parts = state.path ? state.path.split("/") : [];
  const frag = document.createDocumentFragment();
  const mk = (label, target, current) => {
    const a = document.createElement("span");
    a.className = "crumb" + (current ? " current" : "");
    a.textContent = label;
    a.addEventListener("click", () => loadPath(target));
    return a;
  };
  frag.appendChild(mk("root", "", parts.length === 0));
  let acc = "";
  parts.forEach((part, i) => {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "/";
    frag.appendChild(sep);
    acc = acc ? `${acc}/${part}` : part;
    frag.appendChild(mk(part, acc, i === parts.length - 1));
  });
  els.crumbs.replaceChildren(frag);
}

function filteredEntries() {
  if (!state.filter) return state.entries;
  const q = state.filter.toLowerCase();
  return state.entries.filter((e) => e.name.toLowerCase().includes(q));
}

/* -------------------------------------------------------------------------- */
/*  Virtualised list rendering                                                */
/* -------------------------------------------------------------------------- */

function renderList() {
  const list = filteredEntries();
  els.spacer.style.height = list.length * ROW_HEIGHT + "px";
  els.empty.hidden = list.length !== 0;
  renderVisible();
}

function renderVisible() {
  const list = filteredEntries();
  const scrollTop = els.viewport.scrollTop;
  const height = els.viewport.clientHeight;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(list.length, first + visibleCount);

  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const entry = list[i];
    frag.appendChild(buildRow(entry, i));
  }
  els.rows.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
  els.rows.replaceChildren(frag);
  syncSelectAllState(list);
}

function buildRow(entry, index) {
  const row = document.createElement("div");
  row.className = `row ${entry.type}`;
  row.dataset.name = entry.name;
  if (state.selected.has(entry.name)) row.classList.add("selected");
  const isEditing = state.editing && state.editing.name === entry.name;
  if (isEditing) row.classList.add("editing");
  // Dim entries that are queued for a move from this exact folder so the
  // user can see what's "in transit". (Copies don't dim — the originals stay.)
  if (
    state.clipboard &&
    state.clipboard.mode === "move" &&
    state.clipboard.sourcePath === state.path &&
    state.clipboard.names.includes(entry.name)
  ) {
    row.classList.add("clipped");
  }

  const inClipboardMode = !!state.clipboard;
  const check = document.createElement("label");
  check.className = "cell cell-check";
  // selector is the <input> the row click handler must ignore (so a click on
  // the input itself doesn't double-fire). null when there's no selector at
  // all (files while a cut/copy is pending).
  /** @type {HTMLInputElement|null} */
  let selector = null;
  if (inClipboardMode) {
    // Clipboard mode: the listing acts as a destination picker. Only folders
    // are selectable, and only one at a time — radio buttons enforce that.
    // Files render no selector at all (and the row is dimmed) so it's
    // visually obvious they aren't valid paste destinations and there's
    // nothing for the user to click.
    if (entry.type === "dir") {
      selector = document.createElement("input");
      selector.type = "radio";
      selector.name = "paste-target";
      selector.checked = state.selected.has(entry.name);
      selector.addEventListener("click", (ev) => ev.stopPropagation());
      selector.addEventListener("change", () => {
        state.selected.clear();
        if (selector.checked) state.selected.add(entry.name);
        renderVisible();
        renderClipboard();
        renderSelection();
      });
      check.appendChild(selector);
    } else {
      row.classList.add("not-a-target");
    }
  } else {
    selector = document.createElement("input");
    selector.type = "checkbox";
    selector.checked = state.selected.has(entry.name);
    selector.addEventListener("click", (ev) => ev.stopPropagation());
    selector.addEventListener("change", () => toggleSelect(entry.name, selector.checked));
    check.appendChild(selector);
  }

  const name = document.createElement("div");
  name.className = "cell cell-name";

  if (isEditing) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "name-input";
    input.value = state.editing.value;
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("input", () => {
      if (state.editing) state.editing.value = input.value;
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commitRename(entry);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cancelRename();
      }
    });
    input.addEventListener("blur", () => {
      // Treat blur as cancel — commits are explicit (Enter or the save
      // button). Avoids accidental renames from focus shifts.
      if (state.editing && state.editing.name === entry.name) cancelRename();
    });
    name.appendChild(input);
    // Focus + select base name (sans extension) once the row is in the DOM.
    queueMicrotask(() => {
      input.focus();
      const dot = entry.type === "file" ? entry.name.lastIndexOf(".") : -1;
      if (dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    });
  } else {
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = entry.name;
    name.appendChild(label);
  }

  const size = document.createElement("div");
  size.className = "cell cell-size";
  size.textContent = entry.type === "dir" ? "—" : fmtSize(entry.size);

  const mtime = document.createElement("div");
  mtime.className = "cell cell-mtime";
  mtime.textContent = fmtTime(entry.mtime);

  const actions = document.createElement("div");
  actions.className = "cell cell-actions";
  // Edit-content button (text files): opens the fullscreen editor. We show
  // it on every file regardless of extension — the editor itself warns when
  // the file looks binary. Hiding it for directories keeps the UI clean.
  if (entry.type === "file") {
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "row-action";
    openBtn.title = "Edit text";
    openBtn.setAttribute("aria-label", `Edit ${entry.name}`);
    openBtn.textContent = "📝";
    openBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openEditor(entry);
    });
    actions.append(openBtn);
  }
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "row-action";
  editBtn.title = "Rename";
  editBtn.setAttribute("aria-label", `Rename ${entry.name}`);
  editBtn.textContent = "✎";
  editBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    beginRename(entry);
  });
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "row-action danger";
  delBtn.title = "Delete";
  delBtn.setAttribute("aria-label", `Delete ${entry.name}`);
  delBtn.textContent = "🗑";
  delBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    deleteEntry(entry);
  });
  actions.append(editBtn, delBtn);

  row.append(check, name, size, mtime, actions);

  // Single click on a dir drills in; on a file it opens the preview. Use
  // the checkbox to select files. While a cut/copy is pending, file rows
  // are inert (no checkbox, no preview).
  row.addEventListener("click", (ev) => {
    if (selector && ev.target === selector) return;
    if (isEditing) return;
    if (entry.type === "dir") {
      const next = state.path ? `${state.path}/${entry.name}` : entry.name;
      loadPath(next);
    } else if (!inClipboardMode) {
      openPreview(entry);
    }
  });

  return row;
}

function toggleSelect(name, selected) {
  if (selected) state.selected.add(name);
  else state.selected.delete(name);
  renderVisible();
  renderSelection();
}

function syncSelectAllState(list) {
  // "Select all" makes no sense while picking a single destination folder.
  els.selectAll.hidden = !!state.clipboard;
  if (state.clipboard) {
    els.selectAll.checked = false;
    els.selectAll.indeterminate = false;
    return;
  }
  if (list.length === 0) {
    els.selectAll.checked = false;
    els.selectAll.indeterminate = false;
    return;
  }
  const selectedHere = list.filter((e) => state.selected.has(e.name)).length;
  els.selectAll.checked = selectedHere === list.length;
  els.selectAll.indeterminate = selectedHere > 0 && selectedHere < list.length;
}

function renderSelection() {
  if (state.clipboard) {
    // In clipboard mode the selection represents the paste destination, not
    // a set of source items, so cut/copy/download don't apply.
    els.btnDownload.disabled = true;
    els.btnCut.disabled = true;
    els.btnCopy.disabled = true;
    const target = currentPasteTargetName();
    els.selSummary.textContent = target
      ? `Target: ${target}/`
      : "Pick a destination folder";
    return;
  }
  const n = state.selected.size;
  els.btnDownload.disabled = n === 0;
  els.btnCut.disabled = n === 0;
  els.btnCopy.disabled = n === 0;
  if (n === 0) {
    els.selSummary.textContent = "No items selected";
  } else {
    const sel = state.entries.filter((e) => state.selected.has(e.name));
    const totalBytes = sel.reduce((acc, e) => acc + (e.type === "file" ? e.size : 0), 0);
    const dirs = sel.filter((e) => e.type === "dir").length;
    const files = sel.length - dirs;
    const parts = [];
    if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
    if (dirs) parts.push(`${dirs} folder${dirs === 1 ? "" : "s"}`);
    els.selSummary.textContent = `${parts.join(", ")} • ${fmtSize(totalBytes)}${dirs ? "+" : ""}`;
  }
}

// Returns the name of the currently-selected destination folder in the
// listing (single radio pick), or null when no folder is targeted — paste
// then falls back to the current folder.
function currentPasteTargetName() {
  if (state.selected.size !== 1) return null;
  const name = state.selected.values().next().value;
  const entry = state.entries.find((e) => e.name === name);
  return entry && entry.type === "dir" ? name : null;
}

function currentPasteTargetPath() {
  const name = currentPasteTargetName();
  if (!name) return state.path;
  return state.path ? `${state.path}/${name}` : name;
}

/* -------------------------------------------------------------------------- */
/*  Rename / delete                                                           */
/* -------------------------------------------------------------------------- */

function beginRename(entry) {
  state.editing = { name: entry.name, value: entry.name };
  renderVisible();
}

function cancelRename() {
  if (!state.editing) return;
  state.editing = null;
  renderVisible();
}

async function commitRename(entry) {
  if (!state.editing || state.editing.name !== entry.name) return;
  const original = entry.name;
  const next = state.editing.value.trim();
  if (!next || next === original) {
    cancelRename();
    return;
  }
  // Optimistically clear the editing state so the row re-renders as plain text;
  // on failure we'll revert by re-entering edit mode with the typed value.
  const attempted = next;
  state.editing = null;
  renderVisible();
  try {
    const res = await api("/api/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: joinPath(original), newName: attempted }),
    });
    const data = await res.json();
    const newName = data?.name || attempted;
    // Update in place so selection and scroll position survive.
    const idx = state.entries.findIndex((e) => e.name === original);
    if (idx !== -1) {
      state.entries[idx] = { ...state.entries[idx], name: newName };
      if (state.selected.delete(original)) state.selected.add(newName);
    }
    // Keep a pending cut/copy in sync — otherwise paste would send the old
    // name and the server would 404, silently dropping that entry from the
    // batch.
    if (state.clipboard && state.clipboard.sourcePath === state.path) {
      const ci = state.clipboard.names.indexOf(original);
      if (ci !== -1) {
        state.clipboard.names[ci] = newName;
        renderClipboard();
      }
    }
    renderList();
    renderSelection();
  } catch (err) {
    alert(`Rename failed: ${err.message}`);
    // Revert: re-open the editor on the original row with what the user typed
    // so they can correct and retry without retyping from scratch.
    if (state.entries.some((e) => e.name === original)) {
      state.editing = { name: original, value: attempted };
      renderVisible();
    } else {
      // Entry disappeared (e.g. deleted elsewhere) — refresh the listing.
      loadPath(state.path);
    }
  }
}

async function deleteEntry(entry) {
  const kind = entry.type === "dir" ? "folder" : "file";
  const warn =
    entry.type === "dir"
      ? `Delete folder “${entry.name}” and everything inside it?\n\nThis cannot be undone.`
      : `Delete file “${entry.name}”?\n\nThis cannot be undone.`;
  if (!confirm(warn)) return;
  try {
    await api("/api/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: joinPath(entry.name) }),
    });
    state.entries = state.entries.filter((e) => e.name !== entry.name);
    state.selected.delete(entry.name);
    if (state.editing && state.editing.name === entry.name) state.editing = null;
    if (state.clipboard) {
      const cbState = state.clipboard;
      // If the deleted entry is a cut/copied item in its source folder,
      // prune it from the pending batch.
      if (cbState.sourcePath === state.path) {
        cbState.names = cbState.names.filter((n) => n !== entry.name);
      }
      // If the deleted entry is the source folder itself (or an ancestor of
      // it), the clipboard now points at paths that no longer exist — a
      // subsequent paste would 404 for every item. Drop it entirely so the
      // chip and Paste button disappear instead of silently misleading the
      // user.
      if (entry.type === "dir") {
        const deletedPath = joinPath(entry.name);
        if (
          cbState.sourcePath === deletedPath ||
          cbState.sourcePath.startsWith(deletedPath + "/")
        ) {
          state.clipboard = null;
        }
      }
      if (state.clipboard && cbState.names.length === 0) {
        state.clipboard = null;
      }
      renderClipboard();
    }
    renderList();
    renderSelection();
  } catch (err) {
    alert(`Could not delete ${kind}: ${err.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Cut / copy / paste                                                        */
/* -------------------------------------------------------------------------- */

function setClipboard(mode) {
  if (state.selected.size === 0) return;
  // Snapshot the selection so subsequent navigation / re-selection doesn't
  // mutate the pending operation.
  state.clipboard = {
    mode,
    sourcePath: state.path,
    names: Array.from(state.selected),
  };
  // Always clear the selection on enter: the listing now repurposes it as a
  // single-folder destination picker. Source rows from a "cut" stay visible
  // via the .clipped class, which doesn't depend on state.selected.
  state.selected.clear();
  renderClipboard();
  renderVisible();
  renderSelection();
}

function clearClipboard() {
  if (!state.clipboard) return;
  // Re-render any source rows we'd been dimming.
  const wasOnSourcePath = state.clipboard.sourcePath === state.path;
  state.clipboard = null;
  renderClipboard();
  if (wasOnSourcePath) renderVisible();
}

function renderClipboard() {
  const cb = state.clipboard;
  document.body.classList.toggle("clipboard-active", !!cb);
  if (!cb) {
    els.clipboardChip.hidden = true;
    els.btnPaste.disabled = true;
    return;
  }
  els.clipboardChip.hidden = false;
  els.clipboardChip.classList.toggle("is-move", cb.mode === "move");
  els.clipboardChip.classList.toggle("is-copy", cb.mode === "copy");
  els.chipIcon.textContent = cb.mode === "move" ? "✂" : "❐";
  els.chipMode.textContent = cb.mode === "move" ? "Move" : "Copy";
  const n = cb.names.length;
  els.chipSummary.textContent = `${n} item${n === 1 ? "" : "s"}`;
  els.chipFrom.textContent = "/" + cb.sourcePath;
  // Target = the radio-picked subfolder if any, otherwise the current folder.
  // Disable paste when the target is exactly the source folder — that would
  // be a no-op (for copy the server would treat each name as a conflict).
  const targetPath = currentPasteTargetPath();
  els.btnPaste.disabled = cb.sourcePath === targetPath;
  els.btnPaste.title =
    cb.sourcePath === targetPath
      ? "Already in this folder"
      : `Paste into /${targetPath} (⌘/Ctrl+V)`;
}

async function pasteHere() {
  const cb = state.clipboard;
  if (!cb) return;
  // Guard against a second click while the first paste is in flight — the
  // server would race against itself (move: ENOENT on the just-moved
  // source; copy: 409 conflicts on the freshly-written dest).
  if (els.btnPaste.disabled) return;
  const to = currentPasteTargetPath();
  if (cb.sourcePath === to) return;
  const from = cb.names.map((n) =>
    cb.sourcePath ? `${cb.sourcePath}/${n}` : n,
  );
  const wasMove = cb.mode === "move";
  const targetIsCurrent = to === state.path;
  const originalHTML = els.btnPaste.innerHTML;
  els.btnPaste.disabled = true;
  els.btnPaste.textContent = wasMove ? "Moving…" : "Copying…";
  let result;
  try {
    result = await runTransfer(cb.mode, from, to, "fail");
  } finally {
    els.btnPaste.innerHTML = originalHTML;
  }
  if (!result) {
    // User cancelled — reset paste-button state via the normal renderer.
    renderClipboard();
    return;
  }
  // On a successful move we consume the clipboard; for copy we keep it so
  // the user can paste into multiple destinations (matches OS conventions).
  if (wasMove) {
    state.clipboard = null;
    renderClipboard();
  }
  summariseTransferResult(cb.mode, result);
  // If the user picked a subfolder as the destination, follow the files
  // into it so they get visual confirmation that the move/copy actually
  // landed somewhere. Without this the current view just empties out and
  // the files appear to have vanished.
  if (!targetIsCurrent && transferLanded(result)) {
    loadPath(to);
  } else {
    loadPath(state.path);
  }
}

// True when at least one item actually moved/copied/overwrote — i.e. the
// transfer produced a real destination we can navigate to.
function transferLanded(body) {
  if (!body || !Array.isArray(body.results)) return false;
  return body.results.some(
    (r) =>
      r.status === "moved" ||
      r.status === "copied" ||
      r.status === "overwritten",
  );
}

async function runTransfer(mode, from, to, onConflict) {
  const csrf = getCsrfToken();
  const headers = { "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  let res;
  try {
    res = await fetch(`/api/${mode}`, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({ from, to, onConflict }),
    });
  } catch (err) {
    alert(`${mode === "move" ? "Move" : "Copy"} failed: ${err.message}`);
    return null;
  }
  if (res.status === 401) {
    redirectToLogin();
    return null;
  }
  if (res.status === 409) {
    // Server detected name collisions — let the user resolve them.
    const body = await res.json().catch(() => ({}));
    const choice = await askConflictResolution(body.conflicts || []);
    if (!choice) return null;
    return await runTransfer(mode, from, to, choice);
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    alert(`${mode === "move" ? "Move" : "Copy"} failed: ${msg}`);
    return null;
  }
  return await res.json();
}

function askConflictResolution(conflicts) {
  const list = conflicts.slice(0, 8).join(", ");
  const more = conflicts.length > 8 ? ` …and ${conflicts.length - 8} more` : "";
  const msg =
    `The destination already contains:\n  ${list}${more}\n\n` +
    `Click OK to overwrite, Cancel to skip these and keep going. ` +
    `(Choose Cancel on the next prompt to abort entirely.)`;
  if (confirm(msg)) return Promise.resolve("overwrite");
  if (confirm("Skip the conflicting items and transfer the rest?")) {
    return Promise.resolve("skip");
  }
  return Promise.resolve(null);
}

function summariseTransferResult(mode, body) {
  if (!body || !Array.isArray(body.results)) return;
  const counts = { moved: 0, copied: 0, overwritten: 0, skipped: 0, error: 0 };
  const errors = [];
  for (const r of body.results) {
    if (counts[r.status] !== undefined) counts[r.status]++;
    if (r.status === "error") errors.push(`${r.name}: ${r.error || "failed"}`);
  }
  if (errors.length > 0) {
    const verb = mode === "move" ? "moved" : "copied";
    const ok = counts.moved + counts.copied + counts.overwritten;
    alert(
      `${ok} ${verb}, ${errors.length} failed:\n\n${errors.slice(0, 10).join("\n")}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Downloads                                                                 */
/* -------------------------------------------------------------------------- */

function joinPath(name) {
  return state.path ? `${state.path}/${name}` : name;
}

async function downloadSelection() {
  const sel = state.entries.filter((e) => state.selected.has(e.name));
  if (sel.length === 0) return;

  if (sel.length === 1 && sel[0].type === "file") {
    const url = `/api/download?path=${encodeURIComponent(joinPath(sel[0].name))}`;
    triggerDownload(url, sel[0].name);
    return;
  }

  const paths = sel.map((e) => joinPath(e.name));
  const zipName = inferZipName(sel);
  els.btnDownload.disabled = true;
  els.btnDownload.textContent = "Zipping…";
  try {
    const res = await api("/api/zip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths, name: zipName }),
    });
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    triggerDownload(objUrl, zipName);
    setTimeout(() => URL.revokeObjectURL(objUrl), 30_000);
  } catch (err) {
    alert(`Zip failed: ${err.message}`);
  } finally {
    els.btnDownload.disabled = false;
    els.btnDownload.textContent = "Download";
  }
}

function inferZipName(sel) {
  if (sel.length === 1) return `${sel[0].name}.zip`;
  const base = state.path ? state.path.split("/").pop() : "root";
  return `${base || "files"}.zip`;
}

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* -------------------------------------------------------------------------- */
/*  Uploads                                                                   */
/* -------------------------------------------------------------------------- */

function uploadFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  els.uploads.hidden = false;
  for (const file of fileList) {
    uploadOne(file);
  }
}

function uploadOne(file) {
  const li = document.createElement("li");
  const name = document.createElement("div");
  name.className = "u-name";
  name.textContent = file.name;
  const state_ = document.createElement("div");
  state_.className = "u-state";
  state_.textContent = "0%";
  const bar = document.createElement("div");
  bar.className = "bar";
  const barFill = document.createElement("div");
  bar.appendChild(barFill);
  li.append(name, state_, bar);
  els.uploadsList.prepend(li);

  const xhr = new XMLHttpRequest();
  const targetDir = state.path;
  const url = `/api/upload?path=${encodeURIComponent(targetDir)}&name=${encodeURIComponent(
    file.name,
  )}`;
  xhr.open("POST", url, true);
  xhr.withCredentials = true;
  xhr.setRequestHeader("content-type", "application/octet-stream");
  const csrf = getCsrfToken();
  if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);

  xhr.upload.addEventListener("progress", (ev) => {
    if (!ev.lengthComputable) return;
    const pct = (ev.loaded / ev.total) * 100;
    barFill.style.width = pct.toFixed(1) + "%";
    state_.textContent = `${pct.toFixed(0)}% • ${fmtSize(ev.loaded)} / ${fmtSize(ev.total)}`;
  });

  xhr.addEventListener("load", () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      li.classList.add("done");
      barFill.style.width = "100%";
      state_.classList.add("ok");
      state_.textContent = `done • ${fmtSize(file.size)}`;
      // Refresh listing if we uploaded into the folder we're viewing.
      if (targetDir === state.path) loadPath(state.path);
    } else if (xhr.status === 401) {
      li.classList.add("err");
      state_.classList.add("err");
      state_.textContent = "signed out";
      redirectToLogin();
    } else {
      li.classList.add("err");
      state_.classList.add("err");
      let msg = `failed (${xhr.status})`;
      try {
        const body = JSON.parse(xhr.responseText);
        if (body.error) msg = body.error;
      } catch {
        /* ignore */
      }
      state_.textContent = msg;
    }
  });

  xhr.addEventListener("error", () => {
    li.classList.add("err");
    state_.classList.add("err");
    state_.textContent = "network error";
  });

  xhr.send(file);
}

/* -------------------------------------------------------------------------- */
/*  Drag-and-drop uploads                                                     */
/* -------------------------------------------------------------------------- */

let dragDepth = 0;
window.addEventListener("dragenter", (ev) => {
  if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes("Files")) return;
  dragDepth++;
  els.dropzonePath.textContent = "/" + state.path;
  els.dropzone.hidden = false;
});
window.addEventListener("dragover", (ev) => {
  if (!els.dropzone.hidden) ev.preventDefault();
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropzone.hidden = true;
});
window.addEventListener("drop", (ev) => {
  if (!els.dropzone.hidden) {
    ev.preventDefault();
    dragDepth = 0;
    els.dropzone.hidden = true;
    if (ev.dataTransfer && ev.dataTransfer.files) {
      uploadFiles(ev.dataTransfer.files);
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

els.viewport.addEventListener("scroll", renderVisible, { passive: true });
window.addEventListener("resize", renderVisible);

els.filter.addEventListener("input", () => {
  state.filter = els.filter.value.trim();
  state.selected.clear();
  renderList();
  renderSelection();
});

els.selectAll.addEventListener("change", () => {
  const list = filteredEntries();
  if (els.selectAll.checked) {
    for (const e of list) state.selected.add(e.name);
  } else {
    for (const e of list) state.selected.delete(e.name);
  }
  renderVisible();
  renderSelection();
});

els.btnUp.addEventListener("click", () => {
  if (!state.path) return;
  const parts = state.path.split("/");
  parts.pop();
  loadPath(parts.join("/"));
});

els.btnRefresh.addEventListener("click", () => loadPath(state.path));

els.btnDownload.addEventListener("click", downloadSelection);
els.btnCut.addEventListener("click", () => setClipboard("move"));
els.btnCopy.addEventListener("click", () => setClipboard("copy"));
els.btnPaste.addEventListener("click", pasteHere);
els.btnClipboardClear.addEventListener("click", clearClipboard);

// Keyboard shortcuts. Ignored while focus is in a text input / textarea so we
// don't intercept the user's typing in filter / rename inputs.
window.addEventListener("keydown", (ev) => {
  // While the inline editor modal is open let it handle its own shortcuts
  // (Cmd-S, Esc, copy/paste inside CodeMirror). Otherwise selecting files
  // and then opening the editor would have Cmd-V paste them into the folder
  // instead of into the document. Same for the preview modal — it handles
  // its own Esc.
  if (editorState.path || previewState.path) return;
  const t = ev.target;
  const tag = t && t.tagName;
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    (t && t.isContentEditable)
  ) {
    if (ev.key === "Escape" && tag === "INPUT" && t.id === "filter") {
      // let the filter handle its own Escape via blur; nothing to do here.
    }
    return;
  }
  const mod = ev.metaKey || ev.ctrlKey;
  if (mod && (ev.key === "x" || ev.key === "X")) {
    // While a cut/copy is pending the selection means "destination folder",
    // so re-cutting would clobber the in-flight operation.
    if (state.selected.size > 0 && !state.clipboard) {
      ev.preventDefault();
      setClipboard("move");
    }
  } else if (mod && (ev.key === "c" || ev.key === "C")) {
    if (state.selected.size > 0 && !state.clipboard) {
      ev.preventDefault();
      setClipboard("copy");
    }
  } else if (mod && (ev.key === "v" || ev.key === "V")) {
    if (state.clipboard && !els.btnPaste.disabled) {
      ev.preventDefault();
      pasteHere();
    }
  } else if (ev.key === "Escape") {
    if (state.clipboard) {
      ev.preventDefault();
      clearClipboard();
    }
  }
});

els.fileInput.addEventListener("change", () => {
  uploadFiles(els.fileInput.files);
  els.fileInput.value = "";
});

els.uploadsClear.addEventListener("click", () => {
  els.uploadsList
    .querySelectorAll("li.done, li.err")
    .forEach((n) => n.remove());
  if (els.uploadsList.children.length === 0) els.uploads.hidden = true;
});

els.btnNewFolder.addEventListener("click", async () => {
  const name = prompt("New folder name");
  if (!name) return;
  try {
    await api("/api/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: state.path, name: name.trim() }),
    });
    loadPath(state.path);
  } catch (err) {
    alert(`Could not create folder: ${err.message}`);
  }
});

els.btnNewFile.addEventListener("click", async () => {
  const raw = prompt("New file name");
  if (!raw) return;
  const name = raw.trim();
  if (!name) return;
  let created;
  try {
    const res = await api("/api/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: state.path, name }),
    });
    created = await res.json();
  } catch (err) {
    alert(`Could not create file: ${err.message}`);
    return;
  }
  await loadPath(state.path);
  // Best-effort: open the editor on the freshly-created file so the user can
  // start typing immediately. Looks up the entry in the now-current listing
  // rather than guessing, in case the server normalised the name.
  const finalName = (created && created.name) || name;
  const entry = state.entries.find((e) => e.name === finalName && e.type === "file");
  if (entry) openEditor(entry);
});

window.addEventListener("hashchange", () => loadPath(pathFromHash()));

function pathFromHash() {
  const h = location.hash || "";
  if (!h.startsWith("#/")) return "";
  return h
    .slice(2)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent)
    .join("/");
}

/* -------------------------------------------------------------------------- */
/*  Inline text editor                                                        */
/*                                                                            */
/*  Fullscreen modal powered by CodeMirror 5 (lazy-loaded from /vendor on     */
/*  first use). Lets the user edit any file in place, with syntax            */
/*  highlighting auto-detected from the filename and a clear warning banner  */
/*  when the file looks binary (saving back would corrupt it).               */
/* -------------------------------------------------------------------------- */

/** Extensions we treat as "obviously not text". The editor still opens —
 *  some users do legitimately want to inspect / surgically patch these —
 *  but we surface a prominent warning and a second confirm on save. */
const BINARY_EXTS = new Set([
  // Images
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tif", "tiff", "heic",
  "heif", "avif", "raw", "psd", "ai",
  // Audio / video
  "mp3", "mp4", "mov", "avi", "wav", "flac", "ogg", "opus", "webm", "mkv",
  "m4a", "m4v", "aac", "wma", "wmv", "flv", "3gp",
  // Archives
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "tbz2", "txz", "lz",
  "lzma", "zst",
  // Executables / object code / libs
  "exe", "dll", "so", "dylib", "bin", "dat", "class", "jar", "pyc", "pyo",
  "wasm", "o", "a", "obj", "lib",
  // Office / PDFs / e-books
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "rtf", "epub", "mobi", "azw3",
  // Fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // Databases / pickles
  "sqlite", "sqlite3", "db", "mdb", "pkl", "parquet",
]);

const editorState = {
  /** Relative path being edited, or null when the editor is closed. */
  path: null,
  /** Original text content used to detect "dirty" state. */
  originalText: null,
  /** Live CodeMirror instance (null when closed). */
  cm: null,
  /** True when the file looked like a binary format on open. */
  looksBinary: false,
};

/** Promise-cached bootstrap of the CodeMirror core + meta addon. */
let codeMirrorBootstrap = null;
/** Per-mode promise cache so re-opening files of the same type is instant. */
const codeMirrorModeCache = new Map();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function ensureCodeMirror() {
  if (window.CodeMirror && window.CodeMirror.findModeByFileName) {
    return Promise.resolve();
  }
  if (!codeMirrorBootstrap) {
    codeMirrorBootstrap = (async () => {
      if (!window.CodeMirror) {
        await loadScript("/vendor/codemirror/lib/codemirror.js");
      }
      // Provides findModeByFileName / findModeByMIME.
      if (!window.CodeMirror.findModeByFileName) {
        await loadScript("/vendor/codemirror/mode/meta.js");
      }
    })();
  }
  return codeMirrorBootstrap;
}

function ensureCodeMirrorMode(modeName) {
  if (!modeName || modeName === "null" || modeName === "plain") {
    return Promise.resolve();
  }
  const cm = window.CodeMirror;
  if (cm && cm.modes && cm.modes[modeName]) return Promise.resolve();
  if (!codeMirrorModeCache.has(modeName)) {
    codeMirrorModeCache.set(
      modeName,
      loadScript(`/vendor/codemirror/mode/${modeName}/${modeName}.js`).catch(
        (err) => {
          // Some "modes" returned by meta.js (e.g. dependent modes) may not
          // resolve to a 1:1 file. Drop the cache entry so a retry is possible
          // and let the editor fall back to plain text.
          codeMirrorModeCache.delete(modeName);
          throw err;
        },
      ),
    );
  }
  return codeMirrorModeCache.get(modeName);
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
}

/** Heuristic: does this byte buffer look like binary content?
 *  We treat a NUL anywhere in the first 8 KB as conclusive (real text files
 *  never contain raw NULs in UTF-8/UTF-16), and accumulate non-printable
 *  control bytes as a softer signal. */
function bytesLookBinary(bytes) {
  const limit = Math.min(bytes.length, 8192);
  let suspicious = 0;
  for (let i = 0; i < limit; i++) {
    const c = bytes[i];
    if (c === 0) return true;
    // Allow common whitespace: \t (9), \n (10), \r (13). Anything else
    // below 0x20 or the DEL byte is suspicious.
    if (c < 0x09 || (c > 0x0d && c < 0x20) || c === 0x7f) {
      suspicious++;
      if (suspicious > 32) return true;
    }
  }
  return false;
}

/** Resolve the best CodeMirror mode for a given filename. */
function detectMode(filename) {
  const cm = window.CodeMirror;
  if (!cm || !cm.findModeByFileName) {
    return { name: "plain", mime: null, label: "plain text" };
  }
  const info = cm.findModeByFileName(filename);
  if (info) {
    return {
      name: info.mode,
      mime: info.mime,
      label: info.name || info.mode,
    };
  }
  return { name: "plain", mime: null, label: "plain text" };
}

async function openEditor(entry) {
  if (editorState.path) return; // single-instance
  let res;
  try {
    res = await api(`/api/file?path=${encodeURIComponent(joinPath(entry.name))}`);
  } catch (err) {
    alert(`Could not open file: ${err.message}`);
    return;
  }

  let bytes;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    alert(`Could not read file: ${err.message}`);
    return;
  }

  // Detection: extension AND content. We surface both so the warning is
  // specific about why we think it's binary.
  const ext = extOf(entry.name);
  const extBinary = BINARY_EXTS.has(ext);
  const contentBinary = bytesLookBinary(bytes);
  const looksBinary = extBinary || contentBinary;

  // Decode as UTF-8 (fatal: false so invalid sequences become U+FFFD instead
  // of throwing — necessary for opening binary files at all).
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  // CodeMirror has to be loaded before we can detect the mode (findModeByFileName
  // is on the meta addon).
  try {
    await ensureCodeMirror();
  } catch (err) {
    alert(`Editor failed to load: ${err.message}`);
    return;
  }
  const modeInfo = detectMode(entry.name);
  if (modeInfo.name && modeInfo.name !== "plain" && modeInfo.name !== "null") {
    try {
      await ensureCodeMirrorMode(modeInfo.name);
    } catch {
      // Soft-fail: continue with plain text.
    }
  }

  // Populate header + warning banner.
  const fullPath = joinPath(entry.name);
  els.editorTitle.textContent = "/" + fullPath;
  els.editorTitle.title = "/" + fullPath;
  els.editorMode.textContent = modeInfo.label || "plain text";
  els.editorDirty.hidden = true;
  if (looksBinary) {
    const reasons = [];
    if (extBinary) reasons.push(`".${ext}" files are normally binary`);
    if (contentBinary) reasons.push("the file contains non-text bytes");
    els.editorWarningMsg.textContent =
      `Warning: ${reasons.join(" and ")}. ` +
      "Saving will overwrite the file with whatever you see below — that will " +
      "corrupt the original. Cancel out unless you really mean to do this.";
    els.editorWarning.hidden = false;
  } else {
    els.editorWarning.hidden = true;
    els.editorWarningMsg.textContent = "";
  }

  editorState.path = fullPath;
  editorState.originalText = text;
  editorState.looksBinary = looksBinary;

  els.editorBody.replaceChildren();
  els.editorModal.hidden = false;
  document.body.classList.add("editor-open");

  // Build the CodeMirror instance only once the modal is visible so it can
  // measure layout correctly.
  const cm = window.CodeMirror(els.editorBody, {
    value: text,
    mode: modeInfo.mime || modeInfo.name || "null",
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    smartIndent: false,
    lineWrapping: false,
    viewportMargin: 50,
    extraKeys: {
      "Cmd-S": () => { saveEditor(); },
      "Ctrl-S": () => { saveEditor(); },
      "Esc": () => { closeEditor(false); },
    },
  });
  // CodeMirror normalises line endings (\r\n → \n) on input, so use what
  // it actually holds as the baseline for the dirty check — otherwise files
  // with CRLF (or NUL bytes that get reinterpreted) appear dirty on open.
  editorState.originalText = cm.getValue();
  cm.setSize("100%", "100%");
  cm.on("change", () => {
    const dirty = cm.getValue() !== editorState.originalText;
    els.editorDirty.hidden = !dirty;
    els.editorSave.disabled = !dirty;
  });
  editorState.cm = cm;
  els.editorSave.disabled = true;
  // Focus after the browser has painted the layout, otherwise CodeMirror
  // measures zero height and the cursor lands somewhere bizarre.
  requestAnimationFrame(() => {
    cm.refresh();
    cm.focus();
  });
}

async function saveEditor() {
  if (!editorState.path || !editorState.cm) return;
  const text = editorState.cm.getValue();
  if (text === editorState.originalText) {
    // No-op save: just close.
    closeEditor(true);
    return;
  }
  if (editorState.looksBinary) {
    const ok = confirm(
      "This file appears to be binary. Saving the text shown will " +
        "permanently overwrite the original bytes and likely corrupt it.\n\n" +
        "Continue anyway?",
    );
    if (!ok) return;
  }

  els.editorSave.disabled = true;
  const prevLabel = els.editorSave.textContent;
  els.editorSave.textContent = "Saving…";
  try {
    const csrf = getCsrfToken();
    const headers = { "content-type": "application/octet-stream" };
    if (csrf) headers["x-csrf-token"] = csrf;
    const res = await fetch(
      `/api/file?path=${encodeURIComponent(editorState.path)}`,
      {
        method: "PUT",
        credentials: "same-origin",
        headers,
        body: text,
      },
    );
    if (res.status === 401) {
      redirectToLogin();
      return;
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const b = await res.json();
        if (b && b.error) msg = b.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    editorState.originalText = text;
    els.editorDirty.hidden = true;
    // If the file lives in the folder we're currently viewing, refresh the
    // listing so size / mtime update.
    const parent = editorState.path.includes("/")
      ? editorState.path.slice(0, editorState.path.lastIndexOf("/"))
      : "";
    closeEditor(true);
    if (parent === state.path) loadPath(state.path);
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  } finally {
    els.editorSave.textContent = prevLabel;
    // disabled state will get refreshed by next change event or close()
    if (editorState.cm) {
      els.editorSave.disabled =
        editorState.cm.getValue() === editorState.originalText;
    }
  }
}

function closeEditor(force) {
  if (!editorState.path) return;
  const dirty =
    editorState.cm &&
    editorState.cm.getValue() !== editorState.originalText;
  if (dirty && !force) {
    if (!confirm("Discard unsaved changes?")) return;
  }
  els.editorModal.hidden = true;
  document.body.classList.remove("editor-open");
  // Drop the CodeMirror DOM so it doesn't hold onto the document /
  // event listeners while the editor is closed.
  els.editorBody.replaceChildren();
  editorState.path = null;
  editorState.originalText = null;
  editorState.cm = null;
  editorState.looksBinary = false;
  els.editorDirty.hidden = true;
  els.editorWarning.hidden = true;
}

els.editorSave.addEventListener("click", () => saveEditor());
els.editorCancel.addEventListener("click", () => closeEditor(false));
// Clicking the dim backdrop closes (with the usual unsaved-changes prompt).
els.editorModal.addEventListener("click", (ev) => {
  if (ev.target === els.editorModal) closeEditor(false);
});
// Modal-scoped key handling. CodeMirror's extraKeys already covers Esc /
// Cmd-S while its textarea is focused; this catches the case where focus is
// on the Save / Cancel buttons (or the warning banner).
els.editorModal.addEventListener("keydown", (ev) => {
  if (!editorState.path) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeEditor(false);
  } else if ((ev.metaKey || ev.ctrlKey) && (ev.key === "s" || ev.key === "S")) {
    ev.preventDefault();
    saveEditor();
  }
});

/* -------------------------------------------------------------------------- */
/*  File preview                                                              */
/*                                                                            */
/*  Fullscreen modal shown when the user taps a file row. Images render     */
/*  directly with format / resolution / size info; text files render in a   */
/*  read-only CodeMirror with syntax highlighting auto-detected from the    */
/*  filename (same lazy-loaded modes as the editor). Anything that looks    */
/*  binary gets a fallback panel with a download button.                    */
/* -------------------------------------------------------------------------- */

/** Extensions the browser can render in an <img>. (HEIC/TIFF etc. are
 *  excluded — most browsers can't decode them.) */
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif",
]);

/** MIME types for building the preview Blob — the download endpoint serves
 *  octet-stream, so we re-tag the bytes for correct decoding. */
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
};

const previewState = {
  /** Relative path being previewed, or null when the preview is closed. */
  path: null,
  /** Live read-only CodeMirror instance for text previews (null otherwise). */
  cm: null,
  /** Object URL backing the current <img>, revoked on close. */
  objectUrl: null,
};

async function openPreview(entry) {
  if (previewState.path) return; // single-instance
  const fullPath = joinPath(entry.name);
  previewState.path = fullPath;

  els.previewTitle.textContent = "/" + fullPath;
  els.previewTitle.title = "/" + fullPath;
  els.previewMeta.textContent = "loading…";
  els.previewBody.replaceChildren(previewNote("⏳", "Loading preview…"));
  els.previewModal.hidden = false;
  document.body.classList.add("preview-open");

  const ext = extOf(entry.name);
  try {
    if (IMAGE_EXTS.has(ext)) {
      await showImagePreview(fullPath, entry, ext);
    } else {
      await showTextPreview(fullPath, entry);
    }
  } catch (err) {
    // Don't clobber the listing if the user closed the modal mid-fetch.
    if (previewState.path !== fullPath) return;
    els.previewMeta.textContent = "error";
    els.previewBody.replaceChildren(
      previewNote("⚠", `Could not load preview: ${err.message}`),
    );
  }
}

async function showImagePreview(fullPath, entry, ext) {
  // Fetch with credentials (an <img src> would too, but going through api()
  // gives us uniform 401 handling and error messages).
  const res = await api(`/api/download?path=${encodeURIComponent(fullPath)}`);
  const raw = await res.blob();
  // Re-tag the octet-stream bytes with the real image type so the browser
  // decodes them (matters for SVG, which is sniffed unreliably).
  const typed = raw.slice(0, raw.size, IMAGE_MIME[ext] || "");
  const objectUrl = URL.createObjectURL(typed);

  const img = document.createElement("img");
  img.className = "preview-image";
  img.alt = entry.name;
  const meta = await new Promise((resolve, reject) => {
    img.addEventListener("load", () =>
      resolve(
        `${ext.toUpperCase()} • ${img.naturalWidth} × ${img.naturalHeight}` +
          ` • ${fmtSize(raw.size)}`,
      ),
    );
    img.addEventListener("error", () =>
      reject(new Error("the file could not be decoded as an image")),
    );
    img.src = objectUrl;
  });

  if (previewState.path !== fullPath) {
    URL.revokeObjectURL(objectUrl);
    return;
  }
  previewState.objectUrl = objectUrl;
  els.previewMeta.textContent = meta;
  els.previewBody.replaceChildren(img);
}

async function showTextPreview(fullPath, entry) {
  const res = await api(`/api/file?path=${encodeURIComponent(fullPath)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  // Not an image and not text — nothing sensible to render.
  if (bytesLookBinary(bytes)) {
    if (previewState.path !== fullPath) return;
    els.previewMeta.textContent = `binary file • ${fmtSize(bytes.byteLength)}`;
    els.previewBody.replaceChildren(
      previewNote(
        "📦",
        "No preview available — this looks like a binary file.",
        `${fmtSize(bytes.byteLength)} • use Download to save it locally`,
      ),
    );
    return;
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  // Detect the format from the filename and lazy-load the matching
  // CodeMirror mode (same machinery as the inline editor).
  await ensureCodeMirror();
  const modeInfo = detectMode(entry.name);
  if (modeInfo.name && modeInfo.name !== "plain" && modeInfo.name !== "null") {
    try {
      await ensureCodeMirrorMode(modeInfo.name);
    } catch {
      // Soft-fail: continue with plain text.
    }
  }

  if (previewState.path !== fullPath) return;
  const lines = text === "" ? 0 : text.split("\n").length;
  els.previewMeta.textContent =
    `${modeInfo.label || "plain text"} • ${lines} line${lines === 1 ? "" : "s"}` +
    ` • ${fmtSize(bytes.byteLength)}`;

  els.previewBody.replaceChildren();
  const cm = window.CodeMirror(els.previewBody, {
    value: text,
    mode: modeInfo.mime || modeInfo.name || "null",
    readOnly: true,
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    lineWrapping: false,
    viewportMargin: 50,
    extraKeys: {
      "Esc": () => { closePreview(); },
    },
  });
  previewState.cm = cm;
  cm.setSize("100%", "100%");
  // Refresh once laid out so CodeMirror measures the viewport correctly.
  requestAnimationFrame(() => cm.refresh());
}

function previewNote(icon, message, detail) {
  const wrap = document.createElement("div");
  wrap.className = "preview-note";
  const iconEl = document.createElement("span");
  iconEl.className = "preview-note-icon";
  iconEl.textContent = icon;
  const msg = document.createElement("span");
  msg.textContent = message;
  wrap.append(iconEl, msg);
  if (detail) {
    const code = document.createElement("code");
    code.textContent = detail;
    wrap.appendChild(code);
  }
  return wrap;
}

function closePreview() {
  if (!previewState.path) return;
  els.previewModal.hidden = true;
  document.body.classList.remove("preview-open");
  if (previewState.objectUrl) {
    URL.revokeObjectURL(previewState.objectUrl);
  }
  // Drop the CodeMirror DOM / image so they don't hold onto resources.
  els.previewBody.replaceChildren();
  previewState.path = null;
  previewState.cm = null;
  previewState.objectUrl = null;
}

els.previewClose.addEventListener("click", closePreview);
els.previewDownload.addEventListener("click", () => {
  if (!previewState.path) return;
  const name = previewState.path.split("/").pop() || "download";
  triggerDownload(
    `/api/download?path=${encodeURIComponent(previewState.path)}`,
    name,
  );
});
// Clicking the dim backdrop closes the preview.
els.previewModal.addEventListener("click", (ev) => {
  if (ev.target === els.previewModal) closePreview();
});
// Modal-scoped Esc handling (covers focus on the buttons; CodeMirror's
// extraKeys covers focus inside a text preview).
els.previewModal.addEventListener("keydown", (ev) => {
  if (!previewState.path) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closePreview();
  }
});

/* -------------------------------------------------------------------------- */
/*  Boot                                                                      */
/* -------------------------------------------------------------------------- */

loadMe();
ping();
setInterval(ping, 5000);
loadPath(pathFromHash());
