// BD_MARKER_JS_TOP
console.log("[NEW TAB LOADED] newtab.js running", new Date().toISOString());
function pad(n) {
  return String(n).padStart(2, "0");
}

const grid = document.getElementById("grid");
const addBtn = document.getElementById("addBtn");
const settingsBtn = document.getElementById("settingsBtn");
const addDialog = document.getElementById("addDialog");
const addForm = document.getElementById("addForm");
const addCancelBtn = addDialog?.querySelector('button[value="cancel"]');
const nameInput = document.getElementById("nameInput");
const urlInput = document.getElementById("urlInput");
const sectionSelect = document.getElementById("sectionSelect");
const sizeRange = document.getElementById("sizeRange");
const sizeResetBtn = document.getElementById("sizeResetBtn");

const STORAGE_KEY = "navicon.links";
const SETTINGS_KEY = "navicon.settings";

const LEGACY_STORAGE_KEY = "betterDial.links";
const LEGACY_SETTINGS_KEY = "betterDial.settings";

const TILE_PRESETS = [140, 180, 240];

// Your default sections (in order)
const DEFAULT_GROUPS = ["Google", "Other"];

let draggedEl = null;
let didDrop = false;
let renderToken = 0;
let _isSizeDragging = false;
let _sizeDragTimer = 0;

/* =========================
   Toast helper
========================= */
function showToast(message, ms = 2600) {
  const el = document.getElementById("toast");
  if (!el) return;

  el.textContent = message;
  el.classList.add("show");

  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => {
    el.classList.remove("show");
  }, ms);
}

// Global: click anywhere closes any open tile menus (portal-safe)
document.addEventListener("click", (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;

  if (t.closest(".tileMenuBtn")) return;
  if (t.closest(".tileMenu")) return;

  document.querySelectorAll(".tileMenu.open").forEach(el => {
    el.classList.remove("open");

    // Clear any portal positioning so it can't "stick" on screen
    el.style.position = "";
    el.style.top = "";
    el.style.left = "";
    el.style.right = "";
    el.style.transform = "";
    el.style.zIndex = "";
    el.style.minWidth = "";
  });
});

window.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
});

window.addEventListener("error", (e) => {
  console.warn("Window error:", e.message || e.error);
});

function makeId() {
  return "l_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function normalizeUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return "https://" + trimmed;
}

function getHostname(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); }
  catch { return u; }
}

async function loadLinks() {
  // 1) Try new key first
  const gotNew = await chrome.storage.local.get(STORAGE_KEY);
  const newLinks = gotNew[STORAGE_KEY];
  if (Array.isArray(newLinks)) return newLinks;

  // 2) Fallback to legacy Better Dial key and migrate forward
  const gotLegacy = await chrome.storage.local.get(LEGACY_STORAGE_KEY);
  const legacyLinks = gotLegacy[LEGACY_STORAGE_KEY];

  if (Array.isArray(legacyLinks)) {
    await chrome.storage.local.set({ [STORAGE_KEY]: legacyLinks });
    return legacyLinks;
  }

  // 3) Nothing stored yet
  return [];
}

async function saveLinks(links) {
  await chrome.storage.local.set({ [STORAGE_KEY]: links });
}

async function dedupeLinksByIdOnce() {
  const s = await loadSettings();
  if (s.__dedupLinksV1) return;

  const links = await loadLinksEnsured();
  const seen = new Set();
  const next = [];

  for (const l of links) {
    if (!l || !l.id) continue;
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    next.push(l);
  }

  if (next.length !== links.length) {
    await saveLinks(next);
    console.log("[DEDUP] Removed duplicates:", links.length - next.length);
  }

  s.__dedupLinksV1 = true;
  await saveSettings(s);
}

async function deleteTile(id) {
  const links = await loadLinksEnsured();
  const next = links.filter(l => l.id !== id);
  await saveLinks(next);
  render();
}

function applyGroupDensitySizing() {
  const root = document.documentElement;
  const mode = root.dataset.layoutMode || "flat";

  // Sections layout only (never flat, never folders)
  const isSections = mode === "sections";

  // Always read the authoritative tile size from computed root style
  const rootTile = parseFloat(
    getComputedStyle(root).getPropertyValue("--tile")
  ) || 160;

  document.querySelectorAll(".groupSection").forEach(section => {
    // Never allow local overrides
    section.style.removeProperty("--tileLocal");

    // Compact applies ONLY in Sections when tiles are small
    section.classList.toggle("compact", isSections && rootTile <= 120);
  });
}

async function editTile(id) {
  const links = await loadLinksEnsured();
  const t = links.find(l => l.id === id);
  if (!t) return;

  const newName = prompt("Name:", t.name || "") ?? t.name;
  if (newName === null) return;

  const newUrlRaw = prompt("URL:", t.url || "") ?? t.url;
  if (newUrlRaw === null) return;

  const newUrl = normalizeUrl(String(newUrlRaw));
  if (!newUrl) return;

  t.name = String(newName).trim();
  t.url = newUrl;

  // refresh suggested group if it was Other and user changed URL
  try {
    const host = new URL(newUrl).hostname.replace(/^www\./, "");
    if (!t.group || t.group === "Other") t.group = suggestGroup(host);
  } catch (err) { console.error("[TILE RENDER ERROR]", err); }

  await saveLinks(links);
  render();
}

async function loadSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY]);
  const s = (data && data[SETTINGS_KEY]) ? data[SETTINGS_KEY] : {};

  // Defaults (only applied when missing)
  if (typeof s.tileSize === "undefined" || s.tileSize === null) s.tileSize = 160;
  if (typeof s.groupMode !== "boolean") s.groupMode = false;

// Pro / promo flags
// promoFreeFolders: true = folders available to everyone (launch mode)
// proEnabled: true = user has lifetime unlock (future)
if (typeof s.promoFreeFolders !== "boolean") s.promoFreeFolders = true;
if (typeof s.proEnabled !== "boolean") s.proEnabled = false;

  // Coerce tileSize to a number (handles legacy string values like "110")
  const t = Number(s.tileSize);
  if (Number.isFinite(t)) s.tileSize = t;

  // One-time migration: legacy defaults -> 160 unless user explicitly chose a size
  // (covers 82/110 stored as number or string)
  if (!s.tileSizeUserSet) {
    const tt = Number(s.tileSize);
    if (tt === 82 || tt === 110) {
      s.tileSize = 160;
      await saveSettings(s);
    }
  }
  // -----------------------------
  // LAYOUT MODE (3-way) + migration
  // -----------------------------
  // New enum: "flat" | "sections" | "folders"
  // Back-compat: older builds stored boolean groupMode (true=sections, false=flat)
  if (typeof s.layoutMode !== "string") {
    if (typeof s.groupMode === "boolean") {
      s.layoutMode = s.groupMode ? "sections" : "flat";
    } else {
      s.layoutMode = "flat";
    }
  }

  // Allowlist to prevent bad/old values from breaking rendering
  if (!["flat", "sections", "folders"].includes(s.layoutMode)) {
    s.layoutMode = "flat";
  }

  // Keep legacy boolean in sync for any old code paths still reading it (temporary safety)
  // NOTE: We'll remove once all render branches use layoutMode.
  s.groupMode = (s.layoutMode !== "flat");
  return s;
}

async function saveSettings(s) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

// =========================
// Pro gating (Folders)
// =========================
async function hasPro() {
  const s = await loadSettings();
  return !!s.proEnabled;
}

async function updateProBadges() {
  const s = await loadSettings();
  const locked = !s.promoFreeFolders && !s.proEnabled;

  document.querySelectorAll("[data-pro-badge]").forEach(el => {
    el.style.display = locked ? "inline-block" : "none";
  });
}

async function canUseFolders() {
  const s = await loadSettings();
  // Launch mode: folders free
  if (s.promoFreeFolders) return true;
  // Later: folders require Pro
  return !!s.proEnabled;
}

async function repairGroupsOnce() {
  const s = await loadSettings();
  if (s.__repairedGroupsV1) return;

  // Never override an existing user-defined groups order.
  // Only ensure a sane default if groups are missing/empty.
  if (!Array.isArray(s.groups) || s.groups.length === 0) {
    s.groups = DEFAULT_GROUPS.slice();
  }

  // Mark migration complete
  s.__repairedGroupsV1 = true;

  await saveSettings(s);
}

async function getGroupsList() {
  const s = await loadSettings();
  const raw = Array.isArray(s.groups) ? s.groups : DEFAULT_GROUPS.slice();

  // Normalize + de-dupe (case-insensitive), preserve order
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const name = String(item ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }

  // Persist only if changed (case-sensitive compare of stored vs normalized)
  const stored = Array.isArray(s.groups) ? s.groups.map(x => String(x ?? "").trim()).filter(Boolean) : [];
  const storedNoDup = [];
  const seen2 = new Set();
  for (const item of stored) {
    const name = String(item ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen2.has(key)) continue;
    seen2.add(key);
    storedNoDup.push(name);
  }

  if (JSON.stringify(storedNoDup) !== JSON.stringify(out)) {
    await setGroupsList(out);
  }

  return out;
}


async function setGroupsList(next) {
  const s = await loadSettings();
  s.groups = next;
  await saveSettings(s);
}

async function ensureValidGroup(name) {
  const groups = await getGroupsList();

  const requested = (name || "").trim();
  const hasRequested =
    requested &&
    groups.some(g => g.toLowerCase() === requested.toLowerCase());

  // Option A retail rule:
  // - If suggested group exists, use it
  // - Otherwise, default to General (never auto-create groups)
  if (hasRequested) return groups.find(g => g.toLowerCase() === requested.toLowerCase());

  // Ensure General always exists in the list
  if (!groups.some(g => g.toLowerCase() === "general")) {
    await setGroupsList(["General", ...groups.filter(g => g.toLowerCase() !== "other"), "Other"]);
  }

  return "General";
}

function applyTileSize(px) {
  const root = document.documentElement;
  const mode = root.dataset.layoutMode || "flat";

  // Slider is globally fixed (must match #sizeRange bounds)
  const SLIDER_MIN = 72;
  const SLIDER_MAX = 160;

  // Folders should feel bigger (mapped from slider range)
  const FOLDER_MIN = 120;
  const FOLDER_MAX = 260;

  const raw = Number(px);
  const sliderVal = Number.isFinite(raw) ? raw : SLIDER_MAX;
  const clamped = Math.max(SLIDER_MIN, Math.min(SLIDER_MAX, sliderVal));

  if (mode === "folders") {
    // Map slider (72..160) -> folder tile size (120..260)
    const t = (clamped - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN); // 0..1
    const folderPx = Math.round(FOLDER_MIN + t * (FOLDER_MAX - FOLDER_MIN));

    root.style.setProperty("--tileFolder", `${folderPx}px`);

    // Keep --tile stable for topbar/button sizing (do not scale topbar with folders)
    root.style.setProperty("--tile", "160px");

    return;
  }

  // Flat + Sections: slider drives --tile directly
  root.style.setProperty("--tile", `${clamped}px`);
}

async function ensureIds(links) {
  let changed = false;
  for (const l of links) {
    if (!l.id) { l.id = makeId(); changed = true; }
  }
  if (changed) await saveLinks(links);
  return links;
}

async function loadLinksEnsured() {
  const links = await loadLinks();
  return ensureIds(links);
}

// --- Smart suggestion -> your groups (can be expanded later)
async function groupOrder(name) {
  const groups = await getGroupsList();
  const idx = groups.indexOf(name);
  return idx === -1 ? 999 : idx;
}

function suggestGroup(host) {
  const h = (host || "").toLowerCase();

  // Google bucket
  if (/(google\.com|gmail\.com|drive\.google\.com|docs\.google\.com|calendar\.google\.com|youtube\.com)/.test(h)) {
    return "Google";
  }

  // Social
  if (/(x\.com|twitter\.com|facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|reddit\.com|discord\.com)/.test(h)) {
    return "Social";
  }

  // Shopping
  if (/(amazon\.com|walmart\.com|target\.com|ebay\.com|etsy\.com|bestbuy\.com|costco\.com)/.test(h)) {
    return "Shopping";
  }

  // Crypto research (exchanges, analytics, explorers, market data)
  if (/(coingecko\.com|coinmarketcap\.com|tradingview\.com|dexscreener\.com|etherscan\.io|basescan\.org|bscscan\.com|solscan\.io|polygonscan\.com|binance\.com|coinbase\.com|kraken\.com)/.test(h)) {
    return "Crypto: Research";
  }

  // Crypto projects (default catch-all for crypto-ish domains)
  if (/(crypto|coin|dex|swap|nft|token|chain|block|web3|defi)/.test(h)) {
    return "Crypto: Projects";
  }

  // Work / tools
  if (/(mail|calendar|docs|drive|notion|slack|zoom|teams|atlassian|jira|confluence|github|gitlab|bitbucket|stackoverflow|aws|azure|gcp|cloudflare)/.test(h)) {
    return "Work";
  }

  return "";
}


async function buildGroups(links) {
  // Use stored order as the source of truth
  const groups = await getGroupsList(); // includes "Other" last

  // Make buckets for every known group
  const buckets = new Map(groups.map(g => [g, []]));

  // Track any groups that appear on tiles but are missing from the stored list
  const missing = [];

  for (const l of links) {
    const host = (() => {
      try { return new URL(l.url).hostname.replace(/^www\./, ""); }
      catch { return ""; }
    })();

    const preferred = l.group || suggestGroup(host);
    const g = await ensureValidGroup(preferred);

    // Ensure bucket exists
    if (!buckets.has(g)) {
      buckets.set(g, []);
      if (g.toLowerCase() !== "other") missing.push(g);
    }

    buckets.get(g).push(l);
  }

  // If we discovered new non-Other groups, append them (before Other) and persist once.
  if (missing.length) {
    const dedup = [];
    const seen = new Set();

    for (const name of missing) {
      const key = name.toLowerCase();
      if (key === "other") continue;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(name);
    }

    if (dedup.length) {
      const base = groups.filter(x => x.toLowerCase() !== "other");
      const updated = [...base, ...dedup, "Other"];
      await setGroupsList(updated);
      const verifySettings = await loadSettings();
      console.log("[DND SAVE PROOF] settings.groups =", verifySettings.groups);

      // Also update local arrays so return order matches immediately
      for (const name of dedup) {
        if (!buckets.has(name)) buckets.set(name, []);
      }
      return updated.map(gname => [gname, buckets.get(gname) || []]);
    }
  }

  return groups.map(gname => [gname, buckets.get(gname) || []]);
}

async function persistOrderFromDOM() {
  // Persist overall order based on DOM tile order (across sections)
  // CRITICAL: dedupe IDs because DOM can momentarily contain repeated tiles during DnD / rebuilds
  const seen = new Set();
  const orderedIds = [];

  for (const el of document.querySelectorAll(".tile")) {
    const id = el.dataset.id;
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    orderedIds.push(id);
  }

  const links = await loadLinksEnsured();
  const byId = new Map(links.map(l => [l.id, l]));

  const next = orderedIds.map(id => byId.get(id)).filter(Boolean);

  // Append any links not present in DOM order
  for (const l of links) {
    if (!seen.has(l.id)) next.push(l);
  }

  await saveLinks(next);
}

function applyThumb(thumb, url) {
  const host = (() => {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
})();

  // High-quality overrides for Google app domains (prevents blurry generic "G")
  const googleIconOverrides = [
    { re: /(^|\.)mail\.google\.com$/,     url: "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico" },
    { re: /(^|\.)drive\.google\.com$/,    url: "https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_96dp.png" },
    { re: /(^|\.)docs\.google\.com$/,     url: "https://ssl.gstatic.com/images/branding/product/2x/docs_2020q4_96dp.png" },
    { re: /(^|\.)sheets\.google\.com$/,   url: "https://ssl.gstatic.com/images/branding/product/2x/sheets_2020q4_96dp.png" },
    { re: /(^|\.)slides\.google\.com$/,   url: "https://ssl.gstatic.com/images/branding/product/2x/slides_2020q4_96dp.png" },
    { re: /(^|\.)calendar\.google\.com$/, url: "https://ssl.gstatic.com/images/branding/product/2x/calendar_2020q4_96dp.png" },
    { re: /(^|\.)meet\.google\.com$/,     url: "https://ssl.gstatic.com/images/branding/product/2x/meet_2020q4_96dp.png" },
  ];

  const override = host ? googleIconOverrides.find(x => x.re.test(host)) : null;
  if (override) {
    thumb.style.backgroundImage = `url("${override.url}")`;
    return;
  }

    // Favicon fallback chain (high-res first to reduce blur)
  const faviconCandidates = host ? [
    // Best general-purpose: higher-res Google S2
    `https://www.google.com/s2/favicons?domain=${host}&sz=256`,

    // Often returns better source artwork for many domains
    `https://icon.horse/icon/${host}`,

    // Common site-hosted icon locations
    `https://${host}/apple-touch-icon.png`,
    `https://${host}/apple-touch-icon-precomposed.png`,
    `https://${host}/favicon-32x32.png`,
    `https://${host}/favicon-48x48.png`,
    `https://${host}/favicon.png`,
    `https://${host}/favicon.ico`,

    // Last resort
    `https://icons.duckduckgo.com/ip3/${host}.ico`
  ] : [];

  const img = new Image();
  let i = 0;

  const apply = (src) => {
    thumb.style.backgroundImage = `url("${src}")`;
  };

  const tryNext = () => {
    if (i >= faviconCandidates.length) {
      thumb.style.backgroundImage = ""; // revert to CSS gradient fallback
      return;
    }
    const src = faviconCandidates[i++];
    img.onload = () => apply(src);
    img.onerror = tryNext;
    img.src = src;
  };

  tryNext();
}

function renderTile(link) {
  const a = document.createElement("a");
  a.className = "tile";
  a.href = link.url;
  a.target = "_self";
  a.rel = "noreferrer";
  a.draggable = true;
  a.dataset.id = link.id;
  const aid = link.id;

  // ⋯ menu button + dropdown
  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "tileMenuBtn";
  menuBtn.textContent = "⋯";

  const menu = document.createElement("div");
  menu.className = "tileMenu";

  const btnEdit = document.createElement("button");
  btnEdit.type = "button";
  btnEdit.textContent = "Edit";
  btnEdit.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    menu.classList.remove("open");
    await editTile(aid);
  });

  const btnDelete = document.createElement("button");
  btnDelete.type = "button";
  btnDelete.textContent = "Delete";
  btnDelete.className = "danger";
  btnDelete.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    menu.classList.remove("open");
    await deleteTile(aid);
  });

  menu.appendChild(btnEdit);
  menu.appendChild(btnDelete);

  // Prevent menu clicks from navigating
  menuBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();

  // Close other menus
  document.querySelectorAll(".tileMenu.open").forEach(el => {
    if (el !== menu) el.classList.remove("open");
  });

  menu.classList.toggle("open");

  // Position menu with fixed coordinates so it's never clipped/behind panels
if (menu.classList.contains("open")) {
  const r = menuBtn.getBoundingClientRect();

  // Set base style
  menu.style.minWidth = "156px";
  menu.style.position = "fixed";
  menu.style.zIndex = "2147483647";
  menu.style.right = "";
  menu.style.transform = "";

  // Place it first so we can measure width
menu.style.top = `${Math.round(r.bottom + 8)}px`;
menu.style.left = "8px";

 // Force layout so width is real
menu.offsetHeight;

 // Measure and center under the 3-dot button
const w = Math.max(156, Math.ceil(menu.getBoundingClientRect().width));
let left = Math.round(r.left + (r.width / 2) - (w / 2));

  // Clamp to viewport
  left = Math.min(window.innerWidth - pad - w, Math.max(pad, left));

  menu.style.left = `${left}px`;
} else {
  // reset so theme CSS still applies when closed
  menu.style.position = "";
  menu.style.top = "";
  menu.style.left = "";
  menu.style.right = "";
  menu.style.transform = "";
  menu.style.zIndex = "";
  menu.style.minWidth = "";
}
});

menu.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });

a.addEventListener("dragstart", (e) => {
  draggedEl = a;
  didDrop = false;
  a.classList.add("dragging");

  const id = a.dataset.id || "";

  // Canonical drag payloads (used by section drop)
  try { e.dataTransfer.setData("application/x-navicon-id", id); } catch {}
  try { e.dataTransfer.setData("application/x-betterdial-id", id); } catch {}
  // Fallback for browsers / older handlers
  try { e.dataTransfer.setData("text/plain", id); } catch {}

  try { e.dataTransfer.effectAllowed = "move"; } catch {}
});

a.addEventListener("dragend", () => {
  a.classList.remove("dragging");
  draggedEl = null;
  // IMPORTANT: no persist/render here — drop handler owns state changes
});

  a.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!draggedEl || draggedEl === a) return;

    const targetGrid = a.closest(".groupGrid");
    const draggedGrid = draggedEl.closest(".groupGrid");

    if (targetGrid && draggedGrid && targetGrid !== draggedGrid) {
      targetGrid.insertBefore(draggedEl, a);
    }

    const parent = a.parentNode;
    if (!parent) return;

    const rect = a.getBoundingClientRect();
    const isAfter = (e.clientX - rect.left) > rect.width / 2;

    if (isAfter) {
      if (a.nextSibling !== draggedEl) parent.insertBefore(draggedEl, a.nextSibling);
    } else {
      if (a !== draggedEl.nextSibling) parent.insertBefore(draggedEl, a);
    }
  });

  // --- Attach menu UI to the tile ---
a.appendChild(menuBtn);
a.appendChild(menu);

// --- Tile contents (thumb + name + url) ---
const thumb = document.createElement("div");
thumb.className = "thumb";
applyThumb(thumb, link.url);
a.appendChild(thumb);

const name = document.createElement("div");
name.className = "name";
name.textContent = link.name || link.title || link.url;
a.appendChild(name);

const urlEl = document.createElement("div");
urlEl.className = "url";
urlEl.textContent = link.url;
a.appendChild(urlEl);

  return a;
}

function renderFolderTile(groupName, items) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "folderTile";
  btn.dataset.group = groupName;

  // =========================
  // Header (title only)
  // =========================
  const head = document.createElement("div");
  head.className = "folderHead";

  const title = document.createElement("div");
  title.className = "folderTitle";
  title.textContent = groupName;

  head.appendChild(title);

  // =========================
  // Count badge (top-right)
  // =========================
  const count = document.createElement("div");
  count.className = "folderCountBadge";
  count.textContent = String(items?.length ?? 0);

  // =========================
  // Preview grid (always 3x3 = 9 icons)
  // =========================
  const preview = document.createElement("div");
  preview.className = "folderPreview";

  const COLS = 3;
  const ROWS = 3;
  const PREVIEW_MAX = 9;
  const targetCells = COLS * ROWS;

  preview.style.setProperty("--fpRows", String(ROWS));
  preview.style.setProperty("--fpCols", String(COLS));

  const previewItems = (items || []).slice(0, PREVIEW_MAX);

  for (const link of previewItems) {
    const cell = document.createElement("div");
    cell.className = "folderPreviewItem";

    const host = (() => {
      try { return new URL(link.url).hostname; }
      catch { return ""; }
    })();

    const img = document.createElement("img");
    img.className = "folderPreviewImg";
    img.alt = "";
    img.decoding = "async";
    img.loading = "lazy";

    // =========================
    // Crisp favicon chain
    // 1) Google high-res PNG
    // 2) DuckDuckGo ICO fallback
    // 3) Remove if both fail
    // =========================
    const googleSrc = host
      ? `https://www.google.com/s2/favicons?domain=${host}&sz=256`
      : "";

    const ddgSrc = host
      ? `https://icons.duckduckgo.com/ip3/${host}.ico`
      : "";

    let triedFallback = false;

    img.src = googleSrc;

    img.addEventListener("error", () => {
      if (!host) {
        img.remove();
        return;
      }

      if (!triedFallback) {
        triedFallback = true;
        img.src = ddgSrc;
        return;
      }

      img.remove();
    });

    cell.appendChild(img);
    preview.appendChild(cell);
  }

  // Pad with empty cells to maintain stable 3x3 footprint
  for (let i = previewItems.length; i < targetCells; i++) {
    const empty = document.createElement("div");
    empty.className = "folderPreviewItem isEmpty";
    preview.appendChild(empty);
  }

  btn.appendChild(head);
  btn.appendChild(count);
  btn.appendChild(preview);

  // Open folder modal on click
  btn.addEventListener("click", () => {
    openFolderModal(groupName, items || []);
  });

  return btn;
}

async function refreshFolderPreviews() {
  // Always show 9 icons (3x3) in folder preview
  const COLS = 3;
  const ROWS = 3;
  const PREVIEW_MAX = 9;
  const targetCells = COLS * ROWS;

  // Load once (prevents jitter / flashing)
  const links = await loadLinksEnsured();
  const groups = await buildGroups(links);

  document
    .querySelectorAll("#grid.folders .folderTile")
    .forEach((btn) => {
      const groupName = btn.dataset.group || "";

      const preview = btn.querySelector(".folderPreview");
      if (!preview) return;

      // Keep CSS math fully locked to 3x3
      preview.style.setProperty("--fpRows", String(ROWS));
      preview.style.setProperty("--fpCols", String(COLS));

      const items = groups.get(groupName) || [];
      const previewItems = items.slice(0, PREVIEW_MAX);

      // Only rebuild the preview area (not the whole tile/grid)
      preview.innerHTML = "";

      for (const link of previewItems) {
        const cell = document.createElement("div");
        cell.className = "folderPreviewItem";

        const host = (() => {
          try { return new URL(link.url).hostname; }
          catch { return ""; }
        })();

        const img = document.createElement("img");
        img.className = "folderPreviewImg";
        img.alt = "";
        img.decoding = "async";
        img.loading = "lazy";

        // =========================
        // Crisp favicon chain
        // 1) Google high-res PNG
        // 2) DuckDuckGo ICO fallback
        // 3) Remove if both fail
        // =========================
        const googleSrc = host
          ? `https://www.google.com/s2/favicons?domain=${host}&sz=256`
          : "";

        const ddgSrc = host
          ? `https://icons.duckduckgo.com/ip3/${host}.ico`
          : "";

        let triedFallback = false;

        img.src = googleSrc;

        img.addEventListener("error", () => {
          if (!host) {
            img.remove();
            return;
          }

          if (!triedFallback) {
            triedFallback = true;
            img.src = ddgSrc;
            return;
          }

          img.remove();
        });

        cell.appendChild(img);
        preview.appendChild(cell);
      }

      // Pad with empties to maintain stable 3x3 footprint
      for (let i = previewItems.length; i < targetCells; i++) {
        const empty = document.createElement("div");
        empty.className = "folderPreviewItem isEmpty";
        preview.appendChild(empty);
      }
    });
}

// =========================
// Folder Modal (Folders Mode)
// =========================

let folderModalEl = null;
let folderModalOpen = false;

function ensureFolderModal() {
  if (folderModalEl) return folderModalEl;

  const overlay = document.createElement("div");
  overlay.id = "folderOverlay";
  overlay.className = "folderOverlay";
  overlay.setAttribute("aria-hidden", "true");

  const modal = document.createElement("div");
  modal.id = "folderModal";
  modal.className = "folderModal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const head = document.createElement("div");
  head.className = "folderModalHead";

  const title = document.createElement("div");
  title.className = "folderModalTitle";
  title.id = "folderModalTitle";
  title.textContent = "Folder";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn folderModalClose";
  closeBtn.setAttribute("aria-label", "Close folder");
  closeBtn.textContent = "✕";

  head.appendChild(title);
  head.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "folderModalBody";
  body.id = "folderModalBody";

  modal.appendChild(head);
  modal.appendChild(body);

  document.body.appendChild(overlay);
  document.body.appendChild(modal);

  // Close behaviors
  overlay.addEventListener("click", closeFolderModal);
  closeBtn.addEventListener("click", closeFolderModal);

  window.addEventListener("keydown", (e) => {
    if (!folderModalOpen) return;
    if (e.key === "Escape") closeFolderModal();
  });

  folderModalEl = modal;
  return modal;
}

function openFolderModal(groupName, items) {
  const modal = ensureFolderModal();
  const overlay = document.getElementById("folderOverlay");
  const title = document.getElementById("folderModalTitle");
  const body = document.getElementById("folderModalBody");

  title.textContent = groupName;

  // Clear + render tiles inside modal
  body.innerHTML = "";
  const innerGrid = document.createElement("div");
  innerGrid.className = "folderInnerGrid";
  innerGrid.dataset.group = groupName;

  for (const link of (items || [])) {
    innerGrid.appendChild(renderTile(link));
  }

  body.appendChild(innerGrid);

  // Show
  overlay.classList.add("open");
  modal.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  folderModalOpen = true;

  // Focus close for accessibility
  const closeBtn = modal.querySelector(".folderModalClose");
  if (closeBtn) closeBtn.focus();
}

function closeFolderModal() {
  const modal = document.getElementById("folderModal");
  const overlay = document.getElementById("folderOverlay");
  if (!modal || !overlay) return;

  modal.classList.remove("open");
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  folderModalOpen = false;
}

async function setTileGroup(tileId, groupName) {
  const links = await loadLinksEnsured();
  const g = await ensureValidGroup(groupName);
  const idx = links.findIndex(l => l.id === tileId);
  if (idx === -1) return;
  links[idx].group = g;
  await saveLinks(links);
}

function makeSection(name, items) {
  const section = document.createElement("section");
  section.className = "groupSection";
  const PREVIEW_LIMIT = 8;

  const header = document.createElement("div");
  header.className = "groupHeader";

  const title = document.createElement("div");
  title.className = "groupTitle";
  title.textContent = name;

  const count = document.createElement("div");
  count.className = "groupCount";
  count.textContent = `${items.length} ${items.length === 1 ? "tile" : "tiles"}`;

  const right = document.createElement("div");
  right.className = "groupHeaderRight";

  // Header assembly (no chevron, no collapse toggle)
  right.appendChild(count);
  header.appendChild(title);
  header.appendChild(right);

  const ggrid = document.createElement("div");
  ggrid.className = "groupGrid";
  ggrid.dataset.group = name;

  const dropPad = document.createElement("div");
  dropPad.className = "dropPad";
  ggrid.appendChild(dropPad);

  // Droppable area: dropping into a section assigns that group
  ggrid.addEventListener("dragover", (e) => {
    e.preventDefault();
    ggrid.classList.add("dragover");
  });

  ggrid.addEventListener("dragleave", () => {
    ggrid.classList.remove("dragover");
  });

  ggrid.addEventListener("drop", async (e) => {
  ggrid.classList.remove("dragover");
  e.preventDefault();
  e.stopPropagation(); // CRITICAL: prevents section drop from also firing

  const dt = e.dataTransfer;
  const id = dt
    ? (dt.getData("application/x-navicon-id") ||
       dt.getData("application/x-betterdial-id") ||
       dt.getData("text/plain"))
    : "";
  if (!id) return;

  didDrop = true;

  await setTileGroup(id, name);
  try { await persistOrderFromDOM(); } catch (err) { console.error("[TILE RENDER ERROR]", err); }
  await render();
});

  // --- Show more / Show less (per-group) ---
  let expanded = false;

  const moreBtn = document.createElement("button");
  moreBtn.className = "groupMoreBtn";
  moreBtn.type = "button";

  const applyExpandedUI = () => {
    const isSelection = !!window.selectionMode;

    // In selection mode, always show all tiles
    const effectiveExpanded = isSelection ? true : expanded;

    let previewLimit = PREVIEW_LIMIT;

    // Calculate full-row preview based on current column count
    if (ggrid) {
      const gridStyles = getComputedStyle(ggrid);
      const columns = gridStyles.gridTemplateColumns.split(" ").length || 1;
      previewLimit = columns * 3; // show 3 full rows
    }

    const visibleCount = effectiveExpanded
      ? items.length
      : Math.min(items.length, previewLimit);

    // Update button text + visibility
    if (!isSelection && items.length > PREVIEW_LIMIT) {
      moreBtn.style.display = "inline-flex";
      moreBtn.textContent = effectiveExpanded ? "Show less" : `Show all (${items.length})`;
      moreBtn.classList.toggle("isCollapsedLabel", !effectiveExpanded);
    } else {
      moreBtn.style.display = "none";
    }

    // Rebuild tiles
    ggrid.innerHTML = "";
    items.slice(0, visibleCount).forEach(link => {
      ggrid.appendChild(renderTile(link));
    });
  };

  moreBtn.addEventListener("click", async (e) => {
    e.stopPropagation(); // don't toggle anything else
    expanded = !expanded;

    const s = await loadSettings();
    s.expandedGroups = s.expandedGroups || {};
    s.expandedGroups[name] = expanded;
    await saveSettings(s);

    applyExpandedUI();
    applyGroupDensitySizing();
  });

  // Put Show all/Show less next to the count
  right.appendChild(moreBtn);

  // Render immediately (prevents empty flash)
  applyExpandedUI();

  // Load persisted expanded state, then render tiles
  (async () => {
    const s = await loadSettings();
    expanded = !!(s.expandedGroups && s.expandedGroups[name]);
    applyExpandedUI();
    applyGroupDensitySizing();
  })();

  section.appendChild(header);
  section.appendChild(ggrid);

  // SECTION DROP TARGET (drop anywhere inside the section box)
section.addEventListener("dragover", (e) => {
  e.preventDefault();
  section.classList.add("dragover");
});

section.addEventListener("dragleave", () => {
  section.classList.remove("dragover");
});

section.addEventListener("drop", async (e) => {
  // If the drop occurred on the inner grid, let ggrid handle it.
  if (e.target && e.target.closest && e.target.closest(".groupGrid")) return;

  e.preventDefault();
  e.stopPropagation();
  section.classList.remove("dragover");

  const dt = e.dataTransfer;
  const id = dt
    ? (dt.getData("application/x-navicon-id") ||
       dt.getData("application/x-betterdial-id") ||
       dt.getData("text/plain"))
    : "";
  if (!id) return;

  didDrop = true;

  await setTileGroup(id, name);
  await persistOrderFromDOM();
  await render();
});

  // END SECTION DROP TARGET

  return section;
}

async function render() {
  const token = ++renderToken;

  await dedupeLinksByIdOnce();

  // Clear immediately (and ensure we're clearing the correct container)
  grid.innerHTML = "";

  const links = await loadLinksEnsured();

  // First install: seed Google apps + set first-run defaults
if (Array.isArray(links) && links.length === 0) {

  const googleLinks = [
    { name: "Gmail", url: "https://mail.google.com" },
    { name: "YouTube", url: "https://youtube.com" },
    { name: "Drive", url: "https://drive.google.com" },
    { name: "Docs", url: "https://docs.google.com" },
    { name: "Sheets", url: "https://sheets.google.com" },
    { name: "Calendar", url: "https://calendar.google.com" },
    { name: "Meet", url: "https://meet.google.com" },
    { name: "Gemini", url: "https://gemini.google.com" },
    { name: "Google", url: "https://google.com" }
  ];

  const seeded = googleLinks.map((l, i) => ({
    id: "seed-" + i + "-" + Date.now(),
    name: l.name,
    url: l.url,
    group: "Google"
  }));

  // Merge with existing settings (safe) and force first-run experience
  const existing = await loadSettings();
  const seededSettings = {
  ...existing,
  theme: "google",
  layoutMode: "sections",
  groupMode: true,
  tileSize:72,
  tileSizeUserSet: true,
  expandedGroups: {
    ...(existing.expandedGroups || {}),
    Google: true
  }
};

  await chrome.storage.local.set({
    [STORAGE_KEY]: seeded,
    [SETTINGS_KEY]: seededSettings
  });

  showToast("We’ve added popular Google apps to get you started.", 6000);

  // Force re-render after seeding
  render();
  return;
}

  if (token !== renderToken) return;

  const s = await loadSettings();

  // Ensure tile size CSS var is applied before any layout is rendered
// Enforce premium minimum (72) so legacy saved values like 64 can't persist
if (typeof s.tileSize === "number" && s.tileSize > 0) {
  const clamped = Math.min(160, Math.max(72, s.tileSize));
  s.tileSize = clamped; // normalize in-memory for downstream slider/UI
  document.documentElement.style.setProperty("--tile", `${clamped}px`);
}

  const layoutMode = s.layoutMode || (s.groupMode ? "sections" : "flat");

  // Sync top-bar UI to settings (layout buttons + slider)
try {
  // Layout segmented control (buttons use data-mode)
  document.querySelectorAll('button[data-mode]').forEach(btn => {
    const mode = btn.getAttribute("data-mode");
    const active = (mode === layoutMode);

    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });

  // Tile size slider is owned by init/mode-switch logic + applyTileSize() + handlers.
// Do not compute mode-aware values here (prevents slider snapping).
const sizeRange = document.getElementById("sizeRange");
if (sizeRange) {
  // intentionally empty
}
} catch {}

  await updateProBadges();  // ← ADD THIS LINE HERE

  const grouped = (layoutMode === "sections"); // ONLY sections uses grouped layout
  if (grid) {
    grid.classList.toggle("grouped", grouped);
    grid.classList.toggle("folders", layoutMode === "folders");
  }

  // Clear again after awaits to prevent append from a stale render
  grid.innerHTML = "";

    // First-run hint (anchor to + Add in header)
  const firstRunHint = document.getElementById("firstRunHint");
  if (firstRunHint) firstRunHint.style.display = (links.length === 0) ? "inline-flex" : "none";

  if (links.length === 0) {
    // Keep grid empty on first run (hint lives in header)
    return;
  }

      // Layout branching (3-mode)
  if (layoutMode === "flat") {
    links.forEach(link => grid.appendChild(renderTile(link)));
    return;
  }

  // Folders mode (new): render folder tiles instead of full sections
  if (layoutMode === "folders") {
    const groups = await buildGroups(links);
    if (token !== renderToken) return;

    grid.innerHTML = "";

    for (const [name, items] of groups) {
      // Retail rule: hide empty "Other"
      if (name.toLowerCase() === "other" && (!items || items.length === 0)) continue;

      grid.appendChild(renderFolderTile(name, items));
    }

    applyGroupDensitySizing();
    return;
  }

  // Sections mode (existing grouped boxes)
  const groups = await buildGroups(links);
  if (token !== renderToken) return;

  // One more defensive clear before painting
  grid.innerHTML = "";

  for (const [name, items] of groups) {
  // Retail rule: hide empty "Other"
  if (
    name.toLowerCase() === "other" &&
    (!items || items.length === 0)
  ) continue;

  grid.appendChild(makeSection(name, items));
}
  applyGroupDensitySizing();
}

// Init sizing + grouped mode
(async () => {
  await repairGroupsOnce();
  const s = await loadSettings();

  // --- Theme (default: apple) ---
  const theme = (s.theme === "warm" || s.theme === "apple" || s.theme === "windows" || s.theme === "google") ? s.theme : "google";
  document.documentElement.dataset.theme = theme;

  // set the radio button state
  document.querySelectorAll('input[name="theme"]').forEach(r => {
    r.checked = (r.value === theme);
  });

  // save + apply on change
  document.querySelectorAll('input[name="theme"]').forEach(r => {
    r.addEventListener("change", async (e) => {
      const s2 = await loadSettings();
      s2.theme = e.target.value;
      await saveSettings(s2);
      document.documentElement.dataset.theme = e.target.value;
    });
  });

  // One-time migration: legacy saved values (82/110, string or number) -> 160
// Only if the user never explicitly set a size.
if (!s.tileSizeUserSet) {
  const tt = Number(s.tileSize);
  if (tt === 82 || tt === 110) {
    s.tileSize = 160;
    await saveSettings(s);
  }
}

// Ensure the root knows the active layout mode BEFORE any sizing happens
{
  const root = document.documentElement;
  const lm = s.layoutMode || (s.groupMode ? "sections" : "flat");
  root.dataset.layoutMode = lm;
}

{
  // Single source of truth: slider value must persist across ALL modes/themes
  const start = Number(s.tileSize ?? 160);
  applyTileSize(start);
}

if (sizeRange) {
  // Smooth slider updates (reduces choppy reflow while dragging)
  let _tileRAF = 0;
  let _tileNext = null;

  sizeRange.addEventListener("input", (e) => {
    _tileNext = e.target.value;

    if (_tileRAF) return;
    _tileRAF = requestAnimationFrame(() => {
      _tileRAF = 0;
      if (_tileNext == null) return;

      applyTileSize(_tileNext);

      // Folders mode: refresh previews in-place (no full re-render = no flashing)
      if ((document.documentElement.dataset.layoutMode || "flat") === "folders") {
        refreshFolderPreviews();
      }
    });
  });

  sizeRange.addEventListener("change", async (e) => {
    const cur = await loadSettings();

    const root = document.documentElement;
    const mode = root.dataset.layoutMode || "flat";

    const raw = Number(e.target.value) || 160;

  // Single source of truth for slider across ALL modes/themes
  cur.tileSize = raw;

    cur.tileSizeUserSet = true;
    await saveSettings(cur);

    if (sizeRange) sizeRange.value = String(raw);
  });
}

if (sizeResetBtn) {
  sizeResetBtn.addEventListener("click", async () => {
    const cur = await loadSettings();
    const root = document.documentElement;
  const mode = root.dataset.layoutMode || "flat";

  // Single source of truth for slider across ALL modes/themes
  const resetVal = 72;
  cur.tileSize = resetVal;

  cur.tileSizeUserSet = true;
  await saveSettings(cur);

  if (sizeRange) sizeRange.value = String(resetVal);
  applyTileSize(resetVal);
  });
}

  // Groups toggle
  if (layoutModeControl) {
  const buttons = Array.from(layoutModeControl.querySelectorAll(".segBtn"));

  const paint = (mode) => {
    for (const btn of buttons) {
      const on = (btn.dataset.mode === mode);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    }
  };

  // Initial paint from settings
  (async () => {
    const s = await loadSettings();
    paint(s.layoutMode || (s.groupMode ? "sections" : "flat"));

  // Keep root dataset in sync so applyTileSize() always knows the real mode
    document.documentElement.dataset.layoutMode = (s.layoutMode || (s.groupMode ? "sections" : "flat"));
    
  // Init slider once (single source of truth across ALL modes)
  if (sizeRange) {
    sizeRange.min = "72";
    sizeRange.max = "160";
    sizeRange.step = "1";

    const v = Number(s.tileSize ?? 160);
    sizeRange.value = String(v);

    applyTileSize(v);
}
  })();

  // Click handler: set layoutMode, persist, repaint, then render
  layoutModeControl.addEventListener("click", async (e) => {
    const btn = e.target.closest(".segBtn");
    if (!btn) return;

       const nextMode = btn.dataset.mode;
    if (!["flat", "sections", "folders"].includes(nextMode)) return;

    // Load current settings first so we can safely fallback if blocked
    const s2 = await loadSettings();
    const currentMode = s2.layoutMode || (s2.groupMode ? "sections" : "flat");

    if (currentMode === nextMode) return;

    // Pro gate: advanced layouts (sections + folders)
    if (nextMode === "sections" || nextMode === "folders") {
      const allowed = await canUseFolders(); // promo OR pro
      if (!allowed) {
        const proDialog = document.getElementById("proDialog");
        if (proDialog && typeof proDialog.showModal === "function") {
          proDialog.showModal();
        } else {
          alert("Sections and Folders are part of Navicon Pro (one-time lifetime unlock).");
        }

        // Force UI back to the current mode (prevents switching)
        paint(currentMode);
        await render();
        return;
      }
    }

    // Allowed: proceed with switch
    s2.layoutMode = nextMode;

    // Keep legacy boolean synced (safety while renderer still uses groupMode)
    s2.groupMode = (nextMode !== "flat");

    await saveSettings(s2);
    paint(nextMode);
    document.documentElement.dataset.layoutMode = nextMode;

  // --- Do not touch slider UI on view switches ---
  // Keep the user's slider position; only re-apply sizing.
if (sizeRange) {
  const v = Number(s2.tileSize ?? 160);
  applyTileSize(v);
}

    // Rendering is still stable...
    await render();
  });
}

await loadLinksEnsured();
render();

  addBtn.addEventListener("click", async () => {
  nameInput.value = "";
  urlInput.value = "";

  if (sectionSelect) {
    const s = await loadSettings();
    const groups = Array.isArray(s.groups) ? s.groups : DEFAULT_GROUPS;

    // Reset options
    sectionSelect.innerHTML = `<option value="">Auto (General)</option>`;

    groups.forEach(g => {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      sectionSelect.appendChild(opt);
    });
  }

  addDialog.showModal();
});

  addCancelBtn?.addEventListener("click", () => addDialog.close());
  addDialog?.addEventListener("click", (e) => {
  if (e.target === addDialog) addDialog.close();
});

settingsDialog?.addEventListener("click", (e) => {
  if (e.target === settingsDialog) settingsDialog.close();
});

  addForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const name = nameInput.value.trim();
  const url = normalizeUrl(urlInput.value);
  if (!url) return;

  const links = await loadLinksEnsured();

  // Duplicate check (by normalized URL)
  const urlKey = url.trim().toLowerCase();
  const existing = links.find(l => (l?.url || "").trim().toLowerCase() === urlKey);

  if (existing) {
    addDialog.close();
    showToast("That link is already saved — not adding a duplicate.", 3200);
    return;
  }

  const host = (() => {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return ""; }
  })();

  let group = "";
  const chosen = sectionSelect ? String(sectionSelect.value || "").trim() : "";

  if (chosen) {
    group = await ensureValidGroup(chosen);
  } else {
    group = await ensureValidGroup(suggestGroup(host));
  }

  links.push({ id: makeId(), name, url, group });
  await saveLinks(links);

  addDialog.close();
  render();
});

  async function renderSectionManager() {
  if (!sectionList) return;

  // ---- one-time DnD wiring (event delegation) ----
// ---- one-time DnD wiring (event delegation) ----
if (!sectionList.dataset.dndInit) {
  sectionList.dataset.dndInit = "1";

  let draggedGroup = "";

  sectionList.addEventListener("dragstart", (e) => {
    const handle = e.target.closest(".dragHandle");
    if (!handle) {
      e.preventDefault();
      return;
    }

    const row = handle.closest(".sectionRow");
    if (!row) return;

    const g = (row.dataset.group || "");
    if (!g) {
      e.preventDefault();
  return;
}

    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", g); } catch (_) {}
    draggedGroup = g;

    row.classList.add("dragging");
  });

  sectionList.addEventListener("dragend", () => {
    for (const el of sectionList.querySelectorAll(".sectionRow.dragging")) {
      el.classList.remove("dragging");
    }
    for (const el of sectionList.querySelectorAll(".sectionRow.dropAbove, .sectionRow.dropBelow")) {
      el.classList.remove("dropAbove", "dropBelow");
    }
    draggedGroup = "";
  });

  // Smooth live reordering while dragging (FLIP)
let dndRaf = 0;
let dndPendingRow = null;
let dndPendingBelow = false;

sectionList.addEventListener("dragover", (e) => {
  const row = e.target.closest(".sectionRow");
  if (!row) return;

  const rowGroup = (row.dataset.group || "");
  if (!rowGroup) return;

  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  // Remove existing indicators
  for (const el of sectionList.querySelectorAll(".sectionRow.dropAbove, .sectionRow.dropBelow")) {
    el.classList.remove("dropAbove", "dropBelow");
  }

  // Decide whether we’re dropping above or below this row
  const rect = row.getBoundingClientRect();
  const mid = rect.top + rect.height / 2;
  const dropBelow = e.clientY >= mid;

  if (dropBelow) row.classList.add("dropBelow");
  else row.classList.add("dropAbove");

  // Queue a single DOM move per animation frame (prevents choppiness)
  dndPendingRow = row;
  dndPendingBelow = dropBelow;

  if (dndRaf) return;
  dndRaf = requestAnimationFrame(() => {
    dndRaf = 0;

    const targetRow = dndPendingRow;
    const targetBelow = dndPendingBelow;
    dndPendingRow = null;

    const draggedRow =
      sectionList.querySelector(".sectionRow.dragging") ||
      sectionList.querySelector(`.sectionRow[data-group="${CSS.escape(draggedGroup)}"]`);

    if (!draggedRow || !targetRow) return;
    if (draggedRow === targetRow) return;

    const fromGroup = (draggedRow.dataset.group || "");
    if (!fromGroup || fromGroup.toLowerCase() === "other") return;

    // Measure BEFORE
    const first = new Map();
    for (const el of sectionList.querySelectorAll(".sectionRow")) {
      first.set(el, el.getBoundingClientRect());
    }

    // Move DOM now (live reorder)
    if (targetBelow) {
      targetRow.insertAdjacentElement("afterend", draggedRow);
    } else {
      targetRow.insertAdjacentElement("beforebegin", draggedRow);
    }

    // Measure AFTER + animate (FLIP)
    for (const el of sectionList.querySelectorAll(".sectionRow")) {
      const a = first.get(el);
      if (!a) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (dx || dy) {
        el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: "translate(0, 0)" }
          ],
          { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" }
        );
      }
    }
  });
});

  sectionList.addEventListener("dragleave", (e) => {
    if (!sectionList.contains(e.relatedTarget)) {
      for (const el of sectionList.querySelectorAll(".sectionRow.dropAbove, .sectionRow.dropBelow")) {
        el.classList.remove("dropAbove", "dropBelow");
      }
    }
  });

  sectionList.addEventListener("drop", async (e) => {
  e.preventDefault();

  const draggedRow = sectionList.querySelector(".sectionRow.dragging");
  const targetRow = e.target.closest(".sectionRow");
  if (!draggedRow || !targetRow) return;

  const from = (draggedRow.dataset.group || "").trim();
  const to = (targetRow.dataset.group || "").trim();
  if (!from || !to) return;

  // If we "drop onto ourselves" (common with live reordering),
  // just persist the current DOM order.
  if (from === to) {
    await setGroupsList(getSectionOrderFromDOM());

    for (const el of sectionList.querySelectorAll(".sectionRow.dropAbove, .sectionRow.dropBelow")) {
      el.classList.remove("dropAbove", "dropBelow");
    }

    draggedRow.classList.remove("dragging");
    draggedGroup = "";
    render();
    return;
  }

  const dropBelow = targetRow.classList.contains("dropBelow");

  if (dropBelow) targetRow.insertAdjacentElement("afterend", draggedRow);
  else targetRow.insertAdjacentElement("beforebegin", draggedRow);

  await setGroupsList(getSectionOrderFromDOM());

  for (const el of sectionList.querySelectorAll(".sectionRow.dropAbove, .sectionRow.dropBelow")) {
    el.classList.remove("dropAbove", "dropBelow");
  }

  draggedRow.classList.remove("dragging");
  draggedGroup = "";
  render();
});
}

  // ---- render rows ----
  const groups = await getGroupsList();
  sectionList.innerHTML = "";

  for (const g of groups) {
    const row = document.createElement("div");
    row.className = "sectionRow";
    row.dataset.group = g;

    const isOther = (g.toLowerCase() === "other");
    row.draggable = false;

    // Drag handle
    const handle = document.createElement("span");
    handle.className = "dragHandle";
    handle.textContent = "⋮⋮";
    handle.title = "Drag to reorder";
    handle.draggable = true;
    handle.style.cursor = "grab";
    handle.style.userSelect = "none";

    const nameText = document.createElement("div");
    nameText.className = "sectionName";
    nameText.textContent = g;
    nameText.dataset.orig = g;

    const save = document.createElement("button");
save.type = "button";
save.className = "miniBtn";
save.textContent = "Rename";

const del = document.createElement("button");
del.type = "button";
del.className = "miniBtn danger";
del.textContent = "Delete";
del.disabled = false;

// Prevent editing "Other"
if (isOther) {
  save.disabled = true;
  del.disabled = true;
  save.title = "Other can’t be renamed";
  del.title = "Other can’t be deleted";
}

    save.addEventListener("click", async () => {
      const orig = nameText.dataset.orig;
      const nextName = (prompt("Rename section:", orig) || "").trim();
      if (!nextName) return;

      const curGroups = await getGroupsList();
      // prevent rename to existing (case-insensitive)
      const exists = curGroups.some(x => x.toLowerCase() === nextName.toLowerCase());
      if (exists && nextName.toLowerCase() !== String(orig || "").toLowerCase()) return;

      // Update groups list
      const origKey = String(orig || "").trim().toLowerCase();
      const updated = curGroups.map(x => {
      const key = String(x || "").trim().toLowerCase();
      return key === origKey ? nextName : x;
     });
      // Keep Other forced last by setGroupsList/getGroupsList
      await setGroupsList(updated);

      // Update any tiles assigned to old group
      const links = await loadLinksEnsured();
      for (const l of links) {
      const lg = String(l.group || "").trim().toLowerCase();
      if (lg === origKey) l.group = nextName;
      }
      await saveLinks(links);

      await renderSectionManager();
      render();
    });

    del.addEventListener("click", async () => {
  const name = (nameText.dataset.orig || "").trim();
  if (!name) return;

  const curGroups = await getGroupsList();
  const updated = curGroups.filter(x => x !== name);
  await setGroupsList(updated);

  // Choose a fallback group for tiles from the deleted group
  // If no groups remain, tiles will have an empty group and will be re-grouped by ensureValidGroup later.
  const fallback = updated[0] || "";

  const links = await loadLinksEnsured();
  for (const l of links) {
    if ((l.group || "").trim() === name) l.group = fallback;
  }
  await saveLinks(links);

  await renderSectionManager();
  render();
});

    row.appendChild(handle);
    row.appendChild(nameText);
    row.appendChild(save);
    row.appendChild(del);
    sectionList.appendChild(row);
  }
}

  async function addSection(name) {
    const next = (name || "").trim();
    if (!next) return;

    const groups = await getGroupsList();
    if (groups.some(g => g.toLowerCase() == next.toLowerCase())) return;

    // Append new group to the end (no special-case groups)
    await setGroupsList([...groups, next]);

    if (newSectionName) newSectionName.value = "";
    await renderSectionManager();
    render();
  }

  settingsBtn.addEventListener("click", async (e) => {
  if (!settingsDialog) return;

  // Render settings content
  await renderSectionManager();

  // Hidden DEV toggle: hold Shift while opening Settings to reveal it
    // Hidden DEV toggles: hold Shift while opening Settings to reveal them
  const devProRow = document.getElementById("devProRow");
  const devProChk = document.getElementById("devProEnabled");

  const devPromoRow = document.getElementById("devPromoRow");
  const devPromoChk = document.getElementById("devPromoFreeFolders");

  const shiftHeld = !!(e && e.shiftKey);

  const hideDev = () => {
    if (devProRow) devProRow.style.display = "none";
    if (devPromoRow) devPromoRow.style.display = "none";
    if (devProChk) devProChk.onchange = null;
    if (devPromoChk) devPromoChk.onchange = null;
  };

  if (shiftHeld) {
    if (devProRow) devProRow.style.display = "";
    if (devPromoRow) devPromoRow.style.display = "";

    const s = await loadSettings();

    if (devProChk) {
      devProChk.checked = !!s.proEnabled;
      devProChk.onchange = async () => {
        const s2 = await loadSettings();
        s2.proEnabled = !!devProChk.checked; // boolean only
        await saveSettings(s2);
        await updateProBadges();
      };
    }

    if (devPromoChk) {
      devPromoChk.checked = !!s.promoFreeFolders;
      devPromoChk.onchange = async () => {
        const s2 = await loadSettings();
        s2.promoFreeFolders = !!devPromoChk.checked; // boolean only
        await saveSettings(s2);
        await updateProBadges();
      };
    }
  } else {
    hideDev();
  }

  settingsDialog.showModal();
  if (newSectionName) setTimeout(() => newSectionName.focus(), 50);
});

  function getSectionOrderFromDOM() {
  if (!sectionList) return [];
  return Array.from(sectionList.querySelectorAll(".sectionRow"))
    .map(r => (r.dataset.group || "").trim())
    .filter(Boolean);
}

// Persist section order when Settings closes (guarantees last reorder sticks)
// Guard: avoid overwriting a larger imported groups list with a stale/partial DOM list.
if (settingsDialog && !settingsDialog.dataset.persistInit) {
  settingsDialog.dataset.persistInit = "1";

  settingsDialog.addEventListener("close", async () => {
    try {
      const updated = getSectionOrderFromDOM();

      // If nothing in DOM, do nothing
      if (!Array.isArray(updated) || updated.length === 0) return;

      // Compare to what is currently stored
      const s = await loadSettings();
      const current = Array.isArray(s.groups) ? s.groups : DEFAULT_GROUPS.slice();

      // If current has more groups than the DOM list, and DOM list is a subset,
      // it's almost certainly stale (e.g., after import). Don't overwrite.
      const curSet = new Set(current.map(x => String(x).trim().toLowerCase()).filter(Boolean));
      const updSet = new Set(updated.map(x => String(x).trim().toLowerCase()).filter(Boolean));

      const updatedIsSubsetOfCurrent = (() => {
        for (const k of updSet) if (!curSet.has(k)) return false;
        return true;
      })();

      if (current.length > updated.length && updatedIsSubsetOfCurrent) {
        return; // skip overwrite
      }

      await setGroupsList(updated);
      render(); // reflect new order on main screen
    } catch (err) {
      console.warn("[SETTINGS CLOSE PERSIST] failed:", err);
    }
  });
}

  if (addSectionBtn) {
    addSectionBtn.addEventListener("click", async () => {
      await addSection(newSectionName ? newSectionName.value : "");
    });
  }


  function updateSelectUI() {
    if (!selectBtn || !deleteSelectedBtn || !doneSelectBtn) return;

    if (selectionMode) {
      selectBtn.style.display = "none";
      deleteSelectedBtn.style.display = "inline-flex";
      doneSelectBtn.style.display = "inline-flex";
      deleteSelectedBtn.textContent = `Delete (${selectedIds.size})`;
      deleteSelectedBtn.disabled = selectedIds.size === 0;
    } else {
      selectBtn.style.display = "inline-flex";
      deleteSelectedBtn.style.display = "none";
      doneSelectBtn.style.display = "none";
    }
  }


  async function deleteSelectedTiles() {
    if (selectedIds.size === 0) return;
    const ok = confirm(`Delete ${selectedIds.size} selected tile(s)?`);
    if (!ok) return;

    const links = await loadLinksEnsured();
    const next = links.filter(l => !selectedIds.has(l.id));
    await saveLinks(next);

    selectedIds.clear();
    selectionMode = false;
    updateSelectUI();
    render();
  }

    document.getElementById("searchForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const query = document.getElementById("searchInput").value.trim();
    if (!query) return;
    window.location.href = "https://www.google.com/search?q=" + encodeURIComponent(query);
  });

    // =========================
  // Keyboard shortcut: Cmd+K / Ctrl+K focuses search
  // =========================
  document.addEventListener("keydown", (e) => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const mod = isMac ? e.metaKey : e.ctrlKey;

    if (mod && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      const input = document.getElementById("searchInput");
      if (input) input.focus();
    }
  });

    // Set search hint based on OS (⌘K on Mac, Ctrl+K elsewhere)
  const hint = document.getElementById("kbdHint");
  if (hint) {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    hint.textContent = isMac ? "⌘K" : "Ctrl K";
  }

  // =========================
  // Auto-wire version from manifest.json
  // =========================
  const versionEl = document.getElementById("versionPill");
  if (versionEl && chrome?.runtime?.getManifest) {
    const manifest = chrome.runtime.getManifest();
    versionEl.textContent = `v${manifest.version}`;
  }
  // =========================
  // EXPORT BACKUP (Retail signal)
  // =========================
  const exportBtn = document.getElementById("exportBtn");

  if (exportBtn) {
    exportBtn.addEventListener("click", async () => {
      try {
        const manifest = chrome.runtime.getManifest();
        const version = manifest?.version || "unknown";

        // Export must be storage-complete (folders/sections depend on settings + groups)
        const gotLinks = await chrome.storage.local.get(STORAGE_KEY);
        const gotSettings = await chrome.storage.local.get(SETTINGS_KEY);

        const links = Array.isArray(gotLinks[STORAGE_KEY]) ? gotLinks[STORAGE_KEY] : [];
        const settings = (gotSettings[SETTINGS_KEY] && typeof gotSettings[SETTINGS_KEY] === "object")
           ? gotSettings[SETTINGS_KEY]
           : {};

        // groups live inside settings in Navicon; keep legacy `data.groups` too
        const groups = Array.isArray(settings.groups) ? settings.groups : [];

        const payload = {
        app: "Navicon",
        schema: 2,
        version,
        exportedAt: new Date().toISOString(),
        data: {
           links,
           settings,
           groups
       }
    };

        const blob = new Blob(
          [JSON.stringify(payload, null, 2)],
          { type: "application/json" }
        );

        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = `navicon-backup-${version}.json`;
        document.body.appendChild(a);
        a.click();

        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("Export failed:", err);
        alert("Export failed. Check console for details.");
      }
    });
  }
  // =========================
  // IMPORT BACKUP (Retail signal)
  // =========================
  const importBtn = document.getElementById("importBtn");
  const importFile = document.getElementById("importFile");

  if (importBtn && importFile) {
    importBtn.addEventListener("click", () => importFile.click());

    importFile.addEventListener("change", async () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const parsed = JSON.parse(text);

        // Basic validation
        if (!parsed || parsed.app !== "Navicon" || !parsed.data) {
          alert("That file doesn’t look like a Navicon backup.");
          importFile.value = "";
          return;
        }

        const nextLinks = Array.isArray(parsed.data.links) ? parsed.data.links : null;

// settings are optional for old backups; default to current settings
const nextSettings = (parsed.data.settings && typeof parsed.data.settings === "object")
  ? parsed.data.settings
  : await loadSettings();

// groups can come from data.groups (legacy) OR settings.groups (new)
const nextGroups =
  Array.isArray(parsed.data.groups) ? parsed.data.groups :
  (Array.isArray(nextSettings.groups) ? nextSettings.groups : null);

if (!nextLinks) {
  alert("Backup file is missing links data.");
  importFile.value = "";
  return;
}

// Ensure groups are stored where Navicon expects them (inside settings)
if (nextGroups) nextSettings.groups = nextGroups;
// --- CRITICAL: ensure settings.groups includes all groups referenced by imported links ---
// If settings.groups is missing groups that exist on links, Navicon will funnel everything into "General".
{
  const existing = Array.isArray(nextSettings.groups) ? nextSettings.groups : [];
  const seen = new Set(existing.map(g => String(g ?? "").trim().toLowerCase()).filter(Boolean));

  // Keep existing order, append any missing groups found in the imported links
  const repaired = existing.slice();

  for (const l of nextLinks) {
    const g = String(l?.group ?? "").trim();
    if (!g) continue;

    const key = g.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    repaired.push(g);
  }

  // Always ensure "Other" exists and stays last
  const withoutOther = repaired.filter(x => String(x).trim().toLowerCase() !== "other");
  nextSettings.groups = [...withoutOther, "Other"];
}

        // Write into current Navicon keys
        // Ensure imported groups are stored where Navicon expects them (inside settings)
        nextSettings.groups = nextGroups;

        await chrome.storage.local.set({
          [STORAGE_KEY]: nextLinks,
          [SETTINGS_KEY]: nextSettings
       });

       // DEBUG: verify what actually got saved (remove after fix)
{
  const got = await chrome.storage.local.get([SETTINGS_KEY]);
  const sSaved = got[SETTINGS_KEY] || {};
  console.log("[IMPORT DEBUG] saved groups count =", Array.isArray(sSaved.groups) ? sSaved.groups.length : "none");
  console.log("[IMPORT DEBUG] saved groups preview =", Array.isArray(sSaved.groups) ? sSaved.groups.slice(0, 12) : sSaved.groups);
}

        // Refresh UI
        importFile.value = "";
        await render();
        alert("Import complete.");
      } catch (err) {
        console.error("Import failed:", err);
        alert("Import failed. Check console for details.");
        importFile.value = "";
      }
    });
  }

})();
