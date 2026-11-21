"use strict";

const $ = (sel) => document.querySelector(sel);

const ICON_FOLDER =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5v6.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
const ICON_CHEVRON =
  '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M4.5 2.5 8 6l-3.5 3.5"/></svg>';

const state = {
  windowId: null,
  barId: null,
  openFolders: new Set(),
  query: "",
  renaming: false,
  pendingRenameId: null, // 作成直後に名前入力を始めるフォルダ
  collapsed: { bookmarks: false, pinned: false, tabs: false },
  openUrls: new Set(),
};

let dragging = null; // { type: "bookmark", id } | { type: "tab", title, url }

/* ---------------- ユーティリティ ---------------- */

function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", pageUrl);
  u.searchParams.set("size", "32");
  return u.toString();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html; // 固定のSVG文字列のみ。ユーザーデータは textContent で入れる
  return e;
}

function favImg(pageUrl, preferred) {
  const img = el("img");
  img.alt = "";
  img.src = preferred || faviconUrl(pageUrl);
  img.onerror = () => {
    img.onerror = null;
    img.src = faviconUrl(pageUrl);
  };
  return img;
}

function normalizeUrl(u) {
  return (u || "").replace(/#.*$/, "").replace(/\/$/, "");
}

let toastTimer;
function toast(msg, action) {
  const t = $("#toast");
  const text = el("span");
  text.textContent = msg;
  t.replaceChildren(text);
  if (action) {
    const btn = el("button", "toast-btn");
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      t.hidden = true;
      action.run();
    });
    t.append(btn);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 5000 : 1400);
}

/* ---------------- 開く動作（Arc風） ----------------
 * クリック          : 同じURLのタブがあればそこへ切替、なければ新しいタブ
 * Cmd/Ctrl+クリック : バックグラウンドの新しいタブ（中クリックも同じ）
 * Shift+クリック    : 現在のタブで開く
 */
function modeFromEvent(e) {
  if (e.button === 1 || e.metaKey || e.ctrlKey) return "background";
  if (e.shiftKey) return "current";
  return "default";
}

async function openBookmark(url, mode = "default") {
  if (!url || url.startsWith("javascript:")) return;
  const tabs = await chrome.tabs.query({ windowId: state.windowId });

  if (mode === "current") {
    const active = tabs.find((t) => t.active);
    if (active) return chrome.tabs.update(active.id, { url });
  }
  if (mode === "default") {
    const existing = tabs.find((t) => normalizeUrl(t.url || t.pendingUrl) === normalizeUrl(url));
    if (existing) return chrome.tabs.update(existing.id, { active: true });
  }
  return chrome.tabs.create({ windowId: state.windowId, url, active: mode !== "background" });
}

function bindOpen(elm, url) {
  elm.addEventListener("click", (e) => openBookmark(url, modeFromEvent(e)));
  elm.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault(); // 中クリックの自動スクロールを抑止
  });
  elm.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
      e.preventDefault();
      openBookmark(url, "background");
    }
  });
}

/* ---------------- ドラッグ&ドロップ ---------------- */

function clearDropMarks() {
  document
    .querySelectorAll(".drop-before, .drop-after, .drop-into, .drop-zone")
    .forEach((n) => n.classList.remove("drop-before", "drop-after", "drop-into", "drop-zone"));
}

function makeDraggable(elm, payload) {
  elm.draggable = true;
  elm.addEventListener("dragstart", (e) => {
    dragging = payload;
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", payload.url || payload.title || "");
  });
  elm.addEventListener("dragend", () => {
    dragging = null;
    clearDropMarks();
  });
}

function dropPosition(e, elm, { horizontal = false, allowInto = false } = {}) {
  const r = elm.getBoundingClientRect();
  const ratio = horizontal ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
  if (allowInto && ratio > 0.25 && ratio < 0.75) return "into";
  return ratio < 0.5 ? "before" : "after";
}

async function applyDrop(dest) {
  const d = dragging;
  dragging = null;
  if (!d) return;
  try {
    if (d.type === "bookmark") {
      await chrome.bookmarks.move(d.id, dest);
    } else if (d.type === "tab") {
      await chrome.bookmarks.create({ ...dest, title: d.title, url: d.url });
      toast("ブックマークしました");
    }
  } catch (err) {
    console.warn(err);
    toast("そこには移動できません");
  }
}

function makeDropTarget(elm, node, opts) {
  elm.addEventListener("dragover", (e) => {
    if (!dragging || state.query) return;
    if (dragging.type === "bookmark" && dragging.id === node.id) return;
    e.preventDefault();
    e.stopPropagation();
    const pos = dropPosition(e, elm, opts);
    clearDropMarks();
    elm.classList.add(`drop-${pos}`);
    elm.dataset.drop = pos;
    e.dataTransfer.dropEffect = dragging.type === "tab" ? "copy" : "move";
  });
  elm.addEventListener("dragleave", () => elm.classList.remove("drop-before", "drop-after", "drop-into"));
  elm.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = elm.dataset.drop;
    clearDropMarks();
    const dest =
      pos === "into"
        ? { parentId: node.id }
        : { parentId: node.parentId, index: node.index + (pos === "after" ? 1 : 0) };
    applyDrop(dest);
  });
}

function setupFavoritesZone() {
  const fav = $("#favorites");
  fav.addEventListener("dragover", (e) => {
    if (!dragging || state.query) return;
    e.preventDefault();
    clearDropMarks();
    fav.classList.add("drop-zone");
  });
  fav.addEventListener("dragleave", (e) => {
    if (!fav.contains(e.relatedTarget)) fav.classList.remove("drop-zone");
  });
  fav.addEventListener("drop", (e) => {
    e.preventDefault();
    clearDropMarks();
    applyDrop({ parentId: state.barId });
  });
}

/* ---------------- 右クリックメニュー ---------------- */

let menuEl = null;

function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

function showMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  closeMenu();
  if (!items.length) return;
  menuEl = el("div", "menu");
  for (const it of items) {
    const b = el("button", `menu-item${it.danger ? " danger" : ""}`);
    b.textContent = it.label;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeMenu();
      it.action();
    });
    menuEl.append(b);
  }
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4))}px`;
}

document.addEventListener("click", closeMenu);
document.addEventListener("contextmenu", (e) => {
  if (!e.defaultPrevented) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
window.addEventListener("blur", closeMenu);

function bookmarkMenu(node, row) {
  const items = [];
  if (!node.url) {
    items.push({ label: "このフォルダ内に新しいフォルダ", action: () => createFolder(node.id) });
  }
  // 「ブックマークバー」「その他のブックマーク」などのルートフォルダは編集不可
  if (node.parentId === "0" || node.unmodifiable) return items;
  if (node.url) {
    items.push({ label: "新しいタブで開く", action: () => openBookmark(node.url, "new") });
    items.push({ label: "新しいフォルダ", action: () => createFolder(node.parentId, node.index + 1) });
  }
  if (row?.querySelector(".title")) items.push({ label: "名前を変更", action: () => startRename(node, row) });
  items.push({ label: "削除", danger: true, action: () => removeBookmark(node) });
  return items;
}

async function restoreNode(n, parentId, index) {
  const created = await chrome.bookmarks.create({ parentId, index, title: n.title, url: n.url });
  for (const c of n.children || []) await restoreNode(c, created.id);
}

async function removeBookmark(node) {
  try {
    const [snap] = await chrome.bookmarks.getSubTree(node.id);
    if (snap.url) await chrome.bookmarks.remove(node.id);
    else await chrome.bookmarks.removeTree(node.id);
    toast("削除しました", {
      label: "元に戻す",
      run: () => restoreNode(snap, snap.parentId, snap.index).catch(() => toast("元に戻せませんでした")),
    });
  } catch (err) {
    console.warn(err);
    toast("削除できませんでした");
  }
}

// 空き部分・見出しの右クリック用
function blankMenu() {
  return [
    { label: "新しいフォルダ", action: () => createFolder(state.barId) },
    { label: "新しいタブ", action: () => chrome.tabs.create({ windowId: state.windowId }) },
  ];
}

async function createFolder(parentId, index) {
  try {
    // 作ったフォルダが見えるよう、検索を解除し、親フォルダとブックマーク欄を開く
    if (state.query) {
      $("#search").value = "";
      state.query = "";
    }
    if (state.collapsed.bookmarks) setCollapsed("bookmarks", false);
    else applyCollapsed();
    if (parentId !== state.barId && !state.openFolders.has(parentId)) {
      state.openFolders.add(parentId);
      chrome.storage.local.set({ openFolders: [...state.openFolders] });
    }
    const folder = await chrome.bookmarks.create({ parentId, index, title: "無題のフォルダ" });
    state.pendingRenameId = folder.id;
    await renderAll();
  } catch (err) {
    console.warn(err);
    toast("フォルダを作成できませんでした");
  }
}

function startRename(node, row, { isNew = false } = {}) {
  const title = row.querySelector(".title");
  if (!title) return;
  state.renaming = true;
  row.draggable = false;
  const input = el("input", "rename");
  input.value = node.title || "";
  title.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    state.renaming = false;
    const v = input.value.trim();
    if (!save && isNew) {
      // 作成直後にEscで取り消したら、空のフォルダごと消す
      await chrome.bookmarks.removeTree(node.id).catch(() => {});
    } else if (save && v && v !== node.title) {
      await chrome.bookmarks.update(node.id, { title: v }).catch(() => toast("名前を変更できませんでした"));
    }
    renderBookmarks();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

/* ---------------- ブックマーク描画 ---------------- */

function indent(depth) {
  return `${8 + depth * 14}px`;
}

function bookmarkItem(node, depth) {
  const li = el("li", "bookmark");
  const row = el("div", "row");
  row.dataset.id = node.id;
  row.style.paddingLeft = indent(depth);
  row.title = node.url;
  row.dataset.url = node.url;
  const title = el("span", "title");
  title.textContent = node.title || node.url;
  row.append(favImg(node.url), title);
  bindOpen(row, node.url);
  row.addEventListener("contextmenu", (e) => showMenu(e, bookmarkMenu(node, row)));
  if (!state.query) {
    makeDraggable(row, { type: "bookmark", id: node.id, url: node.url });
    makeDropTarget(row, node);
  }
  li.append(row);
  return li;
}

function folderItem(node, depth) {
  const isOpen = state.openFolders.has(node.id);
  const li = el("li", `folder${isOpen ? " open" : ""}`);
  const row = el("div", "row");
  row.dataset.id = node.id;
  row.style.paddingLeft = indent(depth);
  const title = el("span", "title");
  title.textContent = node.title || "(無題のフォルダ)";
  row.append(el("span", "chev", ICON_CHEVRON), el("span", "folder-icon", ICON_FOLDER), title);
  row.addEventListener("click", () => toggleFolder(node.id));
  row.addEventListener("contextmenu", (e) => showMenu(e, bookmarkMenu(node, row)));
  makeDraggable(row, { type: "bookmark", id: node.id, title: node.title });
  makeDropTarget(row, node, { allowInto: true });
  li.append(row);

  if (isOpen) {
    const ul = el("ul");
    const children = node.children || [];
    if (!children.length) {
      const empty = el("li", "empty");
      empty.style.paddingLeft = indent(depth + 1);
      empty.textContent = "空のフォルダ";
      ul.append(empty);
    }
    for (const c of children) ul.append(c.url ? bookmarkItem(c, depth + 1) : folderItem(c, depth + 1));
    li.append(ul);
  }
  return li;
}

function favoriteTile(node) {
  const tile = el("div", "tile");
  if (state.openUrls.has(normalizeUrl(node.url))) tile.classList.add("is-open");
  tile.title = node.title || node.url;
  tile.append(favImg(node.url));
  bindOpen(tile, node.url);
  tile.addEventListener("contextmenu", (e) => showMenu(e, bookmarkMenu(node, null)));
  makeDraggable(tile, { type: "bookmark", id: node.id, url: node.url });
  makeDropTarget(tile, node, { horizontal: true });
  return tile;
}

async function toggleFolder(id) {
  if (state.openFolders.has(id)) state.openFolders.delete(id);
  else state.openFolders.add(id);
  await chrome.storage.local.set({ openFolders: [...state.openFolders] });
  renderBookmarks();
}

async function renderBookmarks() {
  if (state.renaming) return; // 名前の変更中は再描画しない
  const [root] = await chrome.bookmarks.getTree();
  const tops = root.children || [];
  const bar = tops.find((n) => n.folderType === "bookmarks-bar") || tops[0];
  state.barId = bar.id;

  const fav = $("#favorites");
  const tree = $("#tree");
  const nextFav = [];
  const nextTree = [];

  if (state.query) {
    fav.hidden = true;
    const results = (await chrome.bookmarks.search(state.query)).filter((n) => n.url);
    for (const n of results.slice(0, 200)) nextTree.push(bookmarkItem(n, 0));
    if (!results.length) {
      const empty = el("li", "empty");
      empty.textContent = "一致するブックマークはありません";
      nextTree.push(empty);
    }
  } else {
    // 上段のアイコン列は使わず、ブックマークバーの中身をChromeと同じ順でリスト表示
    fav.hidden = true;
    for (const n of bar.children || []) {
      nextTree.push(n.url ? bookmarkItem(n, 0) : folderItem(n, 0));
    }
    // 「その他のブックマーク」「モバイルのブックマーク」は中身がある時だけフォルダとして表示
    for (const top of tops) {
      if (top !== bar && top.children?.length) nextTree.push(folderItem(top, 0));
    }
  }

  fav.replaceChildren(...nextFav);
  tree.replaceChildren(...nextTree);

  // 作成したばかりのフォルダは、そのまま名前の入力欄にする
  if (state.pendingRenameId) {
    const id = state.pendingRenameId;
    const row = tree.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (row) {
      state.pendingRenameId = null;
      const [node] = await chrome.bookmarks.get(id);
      row.scrollIntoView({ block: "nearest" });
      startRename(node, row, { isNew: true });
    }
  }
}

/* ---------------- タブ描画 ---------------- */

function tabMenu(t) {
  return [
    {
      label: t.pinned ? "固定を解除" : "タブを固定",
      action: () => chrome.tabs.update(t.id, { pinned: !t.pinned }),
    },
    { label: "タブを複製", action: () => chrome.tabs.duplicate(t.id) },
    { label: "タブを閉じる", danger: true, action: () => chrome.tabs.remove(t.id) },
  ];
}

function tabItem(t) {
  const url = t.url || t.pendingUrl || "";
  const li = el("li", `tab${t.active ? " active" : ""}`);
  const row = el("div", "row");
  row.title = url;
  const title = el("span", "title");
  title.textContent = t.title || url || "新しいタブ";
  const close = el("button", "close");
  close.textContent = "×";
  close.title = "タブを閉じる";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.tabs.remove(t.id);
  });
  row.append(favImg(url, t.favIconUrl), title, close);
  row.addEventListener("click", () => chrome.tabs.update(t.id, { active: true }));
  row.addEventListener("auxclick", (e) => {
    if (e.button === 1) chrome.tabs.remove(t.id); // 中クリックで閉じる
  });
  row.addEventListener("contextmenu", (e) => showMenu(e, tabMenu(t)));
  if (url && !url.startsWith("chrome://newtab")) {
    makeDraggable(row, { type: "tab", tabId: t.id, pinned: t.pinned, title: t.title || url, url });
  }
  li.append(row);
  return li;
}

async function renderTabs() {
  const tabs = await chrome.tabs.query({ windowId: state.windowId });
  state.openUrls = new Set(tabs.map((t) => normalizeUrl(t.url || t.pendingUrl)));

  const q = state.query.toLowerCase();
  const pinned = [];
  const normal = [];
  for (const t of tabs) {
    const url = t.url || t.pendingUrl || "";
    if (q && !`${t.title} ${url}`.toLowerCase().includes(q)) continue;
    (t.pinned ? pinned : normal).push(tabItem(t));
  }

  // 固定タブが1つもなければセクションごと隠す
  $("#pinnedSection").hidden = !tabs.some((t) => t.pinned) || (q && !pinned.length);
  $("#pinnedTabs").replaceChildren(...pinned);
  $("#tabs").replaceChildren(...normal);
}

async function renderAll() {
  await renderTabs(); // 先にタブを取得して Favorites の「開いている」表示に使う
  await renderBookmarks();
}

/* ---------------- UI・イベント ---------------- */

function applyCollapsed() {
  for (const sec of document.querySelectorAll(".collapsible")) {
    const key = sec.dataset.section;
    const collapsed = !!state.collapsed[key] && !state.query; // 検索中は常に表示
    sec.classList.toggle("collapsed", collapsed);
    sec.querySelector(".section-toggle").setAttribute("aria-expanded", String(!collapsed));
  }
}

function setCollapsed(key, value) {
  state.collapsed[key] = value;
  chrome.storage.local.set({ collapsed: state.collapsed });
  applyCollapsed();
}

function setupCollapsibles() {
  for (const sec of document.querySelectorAll(".collapsible")) {
    const key = sec.dataset.section;
    const toggle = sec.querySelector(".section-toggle");
    toggle.querySelector(".chev").innerHTML = ICON_CHEVRON;
    toggle.addEventListener("click", () => setCollapsed(key, !state.collapsed[key]));
    // 閉じている時にドラッグして重ねたら開く
    toggle.addEventListener("dragenter", () => {
      if (dragging && state.collapsed[key]) setCollapsed(key, false);
    });
  }
}

// 固定タブ以外のタブをすべて閉じる（Arcの「Clear」相当）
async function clearNormalTabs() {
  const tabs = await chrome.tabs.query({ windowId: state.windowId });
  const normal = tabs.filter((t) => !t.pinned);
  if (!normal.length) return toast("閉じるタブはありません");

  const snapshot = normal.map((t) => ({ url: t.url || t.pendingUrl, active: t.active }));
  // 固定タブがない場合はウィンドウが閉じないよう、新しいタブを1つ残す
  if (normal.length === tabs.length) {
    await chrome.tabs.create({ windowId: state.windowId, active: true });
  } else if (normal.some((t) => t.active)) {
    const pinned = tabs.filter((t) => t.pinned);
    await chrome.tabs.update(pinned[pinned.length - 1].id, { active: true });
  }
  await chrome.tabs.remove(normal.map((t) => t.id));

  toast(`${normal.length}個のタブを閉じました`, {
    label: "元に戻す",
    run: async () => {
      for (const t of snapshot) {
        if (!t.url || /^chrome:\/\/(newtab|new-tab-page)/.test(t.url)) continue;
        await chrome.tabs.create({ windowId: state.windowId, url: t.url, active: t.active }).catch(() => {});
      }
    },
  });
}

function bindUI() {
  setupCollapsibles();

  const search = $("#search");
  const onSearch = debounce(() => {
    state.query = search.value.trim();
    applyCollapsed();
    renderAll();
  }, 120);
  search.addEventListener("input", onSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      search.value = "";
      state.query = "";
      applyCollapsed();
      renderAll();
    } else if (e.key === "Enter") {
      const first = document.querySelector("#tree .row[data-url]");
      if (first) openBookmark(first.dataset.url, modeFromEvent(e));
    }
  });

  $("#newTab").addEventListener("click", () => chrome.tabs.create({ windowId: state.windowId }));
  $("#clearTabs").addEventListener("click", clearNormalTabs);

  $("#addBookmark").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
    if (!tab?.url) return;
    const exists = await chrome.bookmarks.search({ url: tab.url }).catch(() => []);
    if (exists.length) return toast("すでにブックマーク済みです");
    await chrome.bookmarks.create({ parentId: state.barId, title: tab.title, url: tab.url });
    toast("ブックマークしました");
  });

  setupFavoritesZone();

  // 行以外（見出し・空いている部分）の右クリック
  document.body.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented || e.target.closest("input")) return;
    showMenu(e, blankMenu());
  });
}

function bindChromeEvents() {
  const scheduleBookmarks = debounce(renderBookmarks, 60);
  const scheduleAll = debounce(renderAll, 60);

  for (const ev of ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered", "onImportEnded"]) {
    chrome.bookmarks[ev].addListener(scheduleBookmarks);
  }
  for (const ev of ["onCreated", "onRemoved", "onUpdated", "onActivated", "onMoved", "onAttached", "onDetached"]) {
    chrome.tabs[ev].addListener(scheduleAll);
  }
}

async function init() {
  // 手動で開いた場合も、この起動中は自動オープン済みとして扱う
  chrome.storage.session.set({ autoOpened: true }).catch(() => {});
  const win = await chrome.windows.getCurrent();
  state.windowId = win.id;
  const saved = await chrome.storage.local.get(["openFolders", "collapsed", "bookmarksCollapsed"]);
  state.openFolders = new Set(saved.openFolders || []);
  state.collapsed = {
    ...state.collapsed,
    bookmarks: !!saved.bookmarksCollapsed, // 旧バージョンの設定を引き継ぐ
    ...(saved.collapsed || {}),
  };
  applyCollapsed();
  bindUI();
  bindChromeEvents();
  await renderAll();
}

init();
