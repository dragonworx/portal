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
  btnDownload: document.getElementById("btn-download"),
  fileInput: document.getElementById("file-input"),
  selSummary: document.getElementById("selection-summary"),
  uploads: document.getElementById("uploads"),
  uploadsList: document.getElementById("uploads-list"),
  uploadsClear: document.getElementById("uploads-clear"),
  dropzone: document.getElementById("dropzone"),
  dropzonePath: document.getElementById("dropzone-path"),
  user: document.getElementById("user"),
  userEmail: document.getElementById("user-email"),
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

function iconFor(entry) {
  return entry.type === "dir" ? "▸" : "•";
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

  const check = document.createElement("label");
  check.className = "cell cell-check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.selected.has(entry.name);
  cb.addEventListener("click", (ev) => ev.stopPropagation());
  cb.addEventListener("change", () => toggleSelect(entry.name, cb.checked));
  check.appendChild(cb);

  const name = document.createElement("div");
  name.className = "cell cell-name";
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = iconFor(entry);
  name.append(icon);

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

  // Single click on a dir drills in; on a file it toggles selection.
  row.addEventListener("click", (ev) => {
    if (ev.target === cb) return;
    if (isEditing) return;
    if (entry.type === "dir") {
      const next = state.path ? `${state.path}/${entry.name}` : entry.name;
      loadPath(next);
    } else {
      toggleSelect(entry.name, !state.selected.has(entry.name));
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
  const n = state.selected.size;
  els.btnDownload.disabled = n === 0;
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
    renderList();
    renderSelection();
  } catch (err) {
    alert(`Could not delete ${kind}: ${err.message}`);
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
/*  Boot                                                                      */
/* -------------------------------------------------------------------------- */

loadMe();
ping();
setInterval(ping, 5000);
loadPath(pathFromHash());
