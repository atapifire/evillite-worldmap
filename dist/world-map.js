// src/WorldMapPlugin.ts
import { Plugin, SettingsTypes } from "@evillite/core";
var _WorldMapPlugin = class _WorldMapPlugin extends Plugin {
  constructor() {
    super(...arguments);
    this.pluginName = "World Map";
    this.author = "HighLite";
    this.settings = {
      enable: {
        text: "Enable World Map",
        type: SettingsTypes.checkbox,
        value: true,
        callback: this.onSettingsChanged_enabled.bind(this)
      }
    };
    // ── DOM ─────────────────────────────────────────────────────────────────────
    this.mapOverlay = null;
    this.mapCanvas = null;
    this.statusEl = null;
    this.panelEl = null;
    this.searchInput = null;
    this.tooltipEl = null;
    // ── Offscreen terrain canvas (1px per tile) ───────────────────────────────────
    this.worldCanvas = null;
    this.worldCtx = null;
    this.worldW = 0;
    this.worldH = 0;
    this.renderInterval = null;
    this.isStarted = false;
    // ── View state (tile units) ───────────────────────────────────────────────────
    this.centerX = 0;
    this.centerZ = 0;
    this.zoom = 4;
    this.followPlayer = true;
    // ── Discovered/accumulated data ───────────────────────────────────────────────
    /** Persistent object store for the current map: key `${x},${z},${floor},${defId}`. */
    this.objectStore = /* @__PURE__ */ new Map();
    /** Persistent NPC sightings: defId -> (key `${x},${z}` -> sighting). */
    this.npcStore = /* @__PURE__ */ new Map();
    this.liveNpcs = [];
    this.liveNpcKeys = /* @__PURE__ */ new Set();
    this.players = [];
    this.mapId = "";
    this.lastDataRefresh = 0;
    this.lastSave = 0;
    this.storeDirty = false;
    // ── Filter state ──────────────────────────────────────────────────────────────
    this.disabledCats = /* @__PURE__ */ new Set();
    this.disabledNames = /* @__PURE__ */ new Set();
    // `${category}:${name}`
    this.showLiveNpcs = true;
    this.showNpcSightings = true;
    this.showPlayers = true;
    this.searchStr = "";
    this.panelSignature = "";
    this.hitTargets = [];
    this.hoverPos = null;
    this.lastPaintedSize = -1;
    this.lastRebuild = 0;
  }
  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  init() {
    this.info("World Map Plugin initializing.");
    this.settings.enable.value = true;
    this.loadFilterState();
    this.start();
  }
  start() {
    if (this.isStarted) return;
    this.isStarted = true;
    this.info("World Map Plugin started.");
    this.createMapOverlay();
    this.installKeyHandler();
  }
  stop() {
    this.isStarted = false;
    this.info("World Map Plugin stopped.");
    this.persistStores(true);
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
    if (this.mapOverlay) {
      this.mapOverlay.remove();
      this.mapOverlay = null;
    }
  }
  onSettingsChanged_enabled() {
    if (this.settings.enable.value) this.start();
    else this.stop();
  }
  // ── Game data access (all by stable semantic names) ───────────────────────────
  get gm() {
    return window.gm ?? null;
  }
  getChunkManager() {
    return this.gm?.chunkManager ?? null;
  }
  getMapId() {
    return this.getChunkManager()?.mapId ?? this.gm?.mapId ?? "default";
  }
  getPlayerPos() {
    const gm = this.gm;
    const mm = gm?.minimap;
    if (mm && mm.hasLastPlayerPosition) return { x: mm.lastPlayerX, z: mm.lastPlayerZ };
    const cam = gm?.camera?.getCamera?.();
    const target = cam?.target ?? cam?.getTarget?.();
    if (target) return { x: target.x, z: target.z };
    const lp = gm?.localPlayer;
    if (lp?.position) return { x: lp.position.x, z: lp.position.z };
    return null;
  }
  catColor(cat) {
    const known = _WorldMapPlugin.CAT_COLOR[cat];
    if (known) return known;
    let h = 0;
    for (let i = 0; i < cat.length; i++) h = h * 31 + cat.charCodeAt(i) & 65535;
    return `hsl(${h % 360}, 65%, 55%)`;
  }
  /** 'square' for building-like, 'diamond' for rocks, 'triangle' for npc, else 'circle'. */
  catShape(cat) {
    if (cat === _WorldMapPlugin.NPC_CAT) return "triangle";
    if (cat === "rock") return "diamond";
    if (cat === "bank" || cat === "furnace" || cat === "cookingrange" || cat === "chest" || cat === "door" || cat === "ladder") return "square";
    return "circle";
  }
  prettify(s) {
    if (!s) return "";
    return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // ── Data collection + accumulation ────────────────────────────────────────────
  refreshData() {
    const now = performance.now();
    if (now - this.lastDataRefresh < 500) return;
    this.lastDataRefresh = now;
    const gm = this.gm;
    if (!gm) return;
    const id = this.getMapId();
    if (id !== this.mapId) {
      this.persistStores(true);
      this.mapId = id;
      this.objectStore.clear();
      this.npcStore.clear();
      this.loadStores();
    }
    this.collectObjects();
    this.collectNpcs();
    this.collectPlayers();
    const sig = this.computePanelSignature();
    if (sig !== this.panelSignature) {
      this.panelSignature = sig;
      this.buildPanel();
    }
    if (this.storeDirty && now - this.lastSave > 4e3) this.persistStores();
  }
  collectObjects() {
    const gm = this.gm;
    const wod = gm.worldObjectDefs;
    const defs = gm.objectDefsCache;
    if (!wod || !defs) return;
    for (const rec of wod.values()) {
      if (!rec || typeof rec.x !== "number" || typeof rec.z !== "number") continue;
      const def = defs.get(rec.defId);
      const category = (def?.category ?? "object") + "";
      const name = (def?.name ?? `#${rec.defId}`) + "";
      const floor = rec.floor ?? 0;
      const key = `${rec.x},${rec.z},${floor},${rec.defId}`;
      const existing = this.objectStore.get(key);
      const depleted = !!rec.depleted;
      if (!existing) {
        this.objectStore.set(key, { defId: rec.defId, category, name, x: rec.x, z: rec.z, floor, depleted });
        this.storeDirty = true;
      } else if (existing.depleted !== depleted) {
        existing.depleted = depleted;
      }
    }
  }
  collectNpcs() {
    const ents = this.gm?.entities;
    this.liveNpcs = [];
    this.liveNpcKeys = /* @__PURE__ */ new Set();
    if (!ents) return;
    const npcDefs = ents.npcDefs;
    const cache = ents.npcDefsCache;
    if (!npcDefs) return;
    for (const [id, defId] of npcDefs) {
      const spr = ents.npcSprites?.get(id);
      const tgt = ents.npcTargets?.get(id);
      let x, z, floor = 0;
      if (spr?.position && spr.isRenderEnabled?.() !== false) {
        x = spr.position.x;
        z = spr.position.z;
      }
      if ((x == null || z == null) && tgt) {
        x = tgt.x;
        z = tgt.z;
        floor = tgt.floor ?? 0;
      }
      if (x == null || z == null) continue;
      const def = cache?.get(defId);
      const name = (def?.name ?? `NPC #${defId}`) + "";
      const level = ents.npcCombatLevels?.get(id);
      this.liveNpcs.push({ id, defId, name, x, z, floor, level });
      this.liveNpcKeys.add(`${defId}:${Math.round(x)},${Math.round(z)}`);
      const rx = Math.round(x), rz = Math.round(z);
      let perDef = this.npcStore.get(defId);
      if (!perDef) {
        perDef = /* @__PURE__ */ new Map();
        this.npcStore.set(defId, perDef);
      }
      const skey = `${rx},${rz}`;
      if (!perDef.has(skey)) {
        if (perDef.size >= _WorldMapPlugin.MAX_SIGHTINGS_PER_NPC) {
          const first = perDef.keys().next().value;
          if (first !== void 0) perDef.delete(first);
        }
        perDef.set(skey, { defId, name, x: rx, z: rz, level });
        this.storeDirty = true;
      }
    }
  }
  collectPlayers() {
    const ents = this.gm?.entities;
    this.players = [];
    if (!ents?.remotePlayers) return;
    for (const [id, spr] of ents.remotePlayers) {
      const pos = spr?.position;
      if (!pos) continue;
      const name = ents.playerNames?.get(id) ?? "";
      this.players.push({ name, x: pos.x, z: pos.z });
    }
  }
  // ── Persistence (localStorage, per map) ───────────────────────────────────────
  storageKey(kind) {
    return `evilitemap:${kind}:${this.mapId}`;
  }
  loadStores() {
    try {
      const objRaw = localStorage.getItem(this.storageKey("obj"));
      if (objRaw) {
        const arr = JSON.parse(objRaw);
        for (const o of arr) {
          const key = `${o.x},${o.z},${o.floor},${o.defId}`;
          this.objectStore.set(key, { defId: o.defId, category: o.category, name: o.name, x: o.x, z: o.z, floor: o.floor, depleted: false });
        }
      }
      const npcRaw = localStorage.getItem(this.storageKey("npc"));
      if (npcRaw) {
        const obj = JSON.parse(npcRaw);
        for (const defIdStr of Object.keys(obj)) {
          const defId = Number(defIdStr);
          const entry = obj[defIdStr];
          const m = /* @__PURE__ */ new Map();
          for (const p of entry.pts) {
            const [x, z, level] = p;
            m.set(`${x},${z}`, { defId, name: entry.name, x, z, level: level < 0 ? void 0 : level });
          }
          this.npcStore.set(defId, m);
        }
      }
    } catch (e) {
      this.warn("loadStores failed: " + (e?.message || e));
    }
  }
  persistStores(force = false) {
    if (!this.mapId) return;
    if (!force && !this.storeDirty) return;
    this.lastSave = performance.now();
    this.storeDirty = false;
    try {
      const objArr = [...this.objectStore.values()].map((o) => ({ defId: o.defId, category: o.category, name: o.name, x: o.x, z: o.z, floor: o.floor }));
      localStorage.setItem(this.storageKey("obj"), JSON.stringify(objArr));
      const npcObj = {};
      for (const [defId, m] of this.npcStore) {
        const first = m.values().next().value;
        npcObj[defId] = { name: first?.name ?? `NPC #${defId}`, pts: [...m.values()].map((s) => [s.x, s.z, s.level ?? -1]) };
      }
      localStorage.setItem(this.storageKey("npc"), JSON.stringify(npcObj));
    } catch (e) {
      this.warn("persistStores failed: " + (e?.message || e));
    }
  }
  loadFilterState() {
    try {
      const raw = localStorage.getItem("evilitemap:filters");
      if (!raw) return;
      const f = JSON.parse(raw);
      this.disabledCats = new Set(f.disabledCats ?? []);
      this.disabledNames = new Set(f.disabledNames ?? []);
      this.showLiveNpcs = f.showLiveNpcs ?? true;
      this.showNpcSightings = f.showNpcSightings ?? true;
      this.showPlayers = f.showPlayers ?? true;
    } catch {
    }
  }
  saveFilterState() {
    try {
      localStorage.setItem("evilitemap:filters", JSON.stringify({
        disabledCats: [...this.disabledCats],
        disabledNames: [...this.disabledNames],
        showLiveNpcs: this.showLiveNpcs,
        showNpcSightings: this.showNpcSightings,
        showPlayers: this.showPlayers
      }));
    } catch {
    }
  }
  // ── Taxonomy helpers ──────────────────────────────────────────────────────────
  /** category -> Map<name, count>, plus the NPC pseudo-category. */
  buildTaxonomy() {
    const tax = /* @__PURE__ */ new Map();
    const add = (cat, name) => {
      let m = tax.get(cat);
      if (!m) {
        m = /* @__PURE__ */ new Map();
        tax.set(cat, m);
      }
      m.set(name, (m.get(name) ?? 0) + 1);
    };
    for (const o of this.objectStore.values()) add(o.category, o.name);
    const npcNames = /* @__PURE__ */ new Map();
    for (const m of this.npcStore.values()) {
      const first = m.values().next().value;
      if (first) npcNames.set(first.name, (npcNames.get(first.name) ?? 0) + m.size);
    }
    if (npcNames.size) tax.set(_WorldMapPlugin.NPC_CAT, npcNames);
    return tax;
  }
  computePanelSignature() {
    const tax = this.buildTaxonomy();
    const parts = [];
    for (const [cat, names] of [...tax].sort((a, b) => a[0].localeCompare(b[0]))) {
      parts.push(cat + "(" + [...names.keys()].sort().join("|") + ")");
    }
    return parts.join(";");
  }
  catEnabled(cat) {
    return !this.disabledCats.has(cat);
  }
  nameEnabled(cat, name) {
    return this.catEnabled(cat) && !this.disabledNames.has(`${cat}:${name}`);
  }
  // ── Overlay UI ────────────────────────────────────────────────────────────────
  createMapOverlay() {
    if (this.mapOverlay) return;
    this.mapOverlay = document.createElement("div");
    Object.assign(this.mapOverlay.style, {
      position: "fixed",
      top: "6%",
      left: "6%",
      width: "88%",
      height: "88%",
      backgroundColor: "rgba(0,0,0,0.93)",
      border: "2px solid var(--theme-border, #444)",
      borderRadius: "8px",
      zIndex: "2147483647",
      display: "none",
      flexDirection: "column",
      padding: "12px",
      boxSizing: "border-box",
      fontFamily: "Inter, sans-serif"
    });
    this.mapOverlay.classList.add("highlite-ui");
    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", color: "#fff", gap: "10px" });
    const title = document.createElement("h2");
    title.innerText = "World Map";
    Object.assign(title.style, { margin: "0", fontSize: "18px", whiteSpace: "nowrap" });
    this.searchInput = document.createElement("input");
    this.searchInput.placeholder = "Search objects & NPCs\u2026";
    Object.assign(this.searchInput.style, {
      flex: "1",
      maxWidth: "320px",
      padding: "6px 10px",
      borderRadius: "4px",
      border: "1px solid #555",
      background: "#1a1a1a",
      color: "#fff",
      fontSize: "13px"
    });
    this.searchInput.oninput = () => {
      this.searchStr = this.searchInput.value.trim().toLowerCase();
    };
    this.searchInput.onkeydown = (e) => {
      if (e.key === "Enter") this.jumpToNearestMatch();
      e.stopPropagation();
    };
    const jumpBtn = document.createElement("button");
    jumpBtn.innerText = "Jump";
    this.styleButton(jumpBtn, "#2c3e50");
    jumpBtn.title = "Centre on the nearest search match";
    jumpBtn.onclick = () => this.jumpToNearestMatch();
    this.statusEl = document.createElement("div");
    Object.assign(this.statusEl.style, { fontSize: "12px", opacity: "0.7", whiteSpace: "nowrap" });
    const followBtn = document.createElement("button");
    followBtn.innerText = "Follow: ON";
    this.styleButton(followBtn, "#2c3e50");
    followBtn.onclick = () => {
      this.followPlayer = !this.followPlayer;
      followBtn.innerText = `Follow: ${this.followPlayer ? "ON" : "OFF"}`;
    };
    const closeBtn = document.createElement("button");
    closeBtn.innerText = "Close";
    this.styleButton(closeBtn, "var(--theme-danger, #e74c3c)");
    closeBtn.onclick = () => this.toggleMap(false);
    const right = document.createElement("div");
    Object.assign(right.style, { display: "flex", gap: "8px", alignItems: "center" });
    right.append(this.statusEl, followBtn, closeBtn);
    header.append(title, this.searchInput, jumpBtn, right);
    const body = document.createElement("div");
    Object.assign(body.style, { flex: "1", display: "flex", gap: "10px", minHeight: "0" });
    this.panelEl = document.createElement("div");
    Object.assign(this.panelEl.style, {
      width: "210px",
      minWidth: "210px",
      overflowY: "auto",
      color: "#fff",
      fontSize: "13px",
      background: "#141414",
      borderRadius: "6px",
      padding: "8px"
    });
    const canvasWrap = document.createElement("div");
    Object.assign(canvasWrap.style, { flex: "1", position: "relative", minWidth: "0" });
    this.mapCanvas = document.createElement("canvas");
    Object.assign(this.mapCanvas.style, {
      width: "100%",
      height: "100%",
      backgroundColor: "#0a0a0a",
      borderRadius: "4px",
      cursor: "grab"
    });
    this.tooltipEl = document.createElement("div");
    Object.assign(this.tooltipEl.style, {
      position: "absolute",
      display: "none",
      pointerEvents: "none",
      background: "rgba(0,0,0,0.9)",
      color: "#fff",
      border: "1px solid #555",
      borderRadius: "4px",
      padding: "4px 8px",
      fontSize: "12px",
      whiteSpace: "nowrap",
      zIndex: "10",
      transform: "translate(8px, 8px)"
    });
    canvasWrap.append(this.mapCanvas, this.tooltipEl);
    body.append(this.panelEl, canvasWrap);
    this.mapOverlay.append(header, body);
    document.body.appendChild(this.mapOverlay);
    this.installCanvasControls();
  }
  styleButton(btn, bg) {
    Object.assign(btn.style, {
      padding: "6px 14px",
      cursor: "pointer",
      backgroundColor: bg,
      border: "none",
      borderRadius: "4px",
      color: "#fff",
      fontFamily: "Inter, sans-serif",
      fontSize: "13px",
      whiteSpace: "nowrap"
    });
  }
  buildPanel() {
    if (!this.panelEl) return;
    const tax = this.buildTaxonomy();
    this.panelEl.innerHTML = "";
    const globals = document.createElement("div");
    globals.style.marginBottom = "8px";
    globals.append(
      this.makeToggle("Players", this.showPlayers, (v) => {
        this.showPlayers = v;
        this.saveFilterState();
      }, "#5dd5ff"),
      this.makeToggle("NPCs (live)", this.showLiveNpcs, (v) => {
        this.showLiveNpcs = v;
        this.saveFilterState();
      }, "#ff5555"),
      this.makeToggle("NPC sightings", this.showNpcSightings, (v) => {
        this.showNpcSightings = v;
        this.saveFilterState();
      }, "#aa4444")
    );
    this.panelEl.appendChild(globals);
    const sep = document.createElement("div");
    Object.assign(sep.style, { height: "1px", background: "#333", margin: "6px 0" });
    this.panelEl.appendChild(sep);
    const cats = [...tax.keys()].sort((a, b) => {
      if (a === _WorldMapPlugin.NPC_CAT) return 1;
      if (b === _WorldMapPlugin.NPC_CAT) return -1;
      return a.localeCompare(b);
    });
    for (const cat of cats) {
      const names = tax.get(cat);
      const total = [...names.values()].reduce((a, b) => a + b, 0);
      const isNpc = cat === _WorldMapPlugin.NPC_CAT;
      const catLabel = isNpc ? "NPCs" : this.prettify(cat);
      const row = document.createElement("div");
      row.style.marginBottom = "2px";
      const head = document.createElement("div");
      Object.assign(head.style, { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" });
      const cb = this.makeCheckbox(this.catEnabled(cat), (v) => {
        if (v) this.disabledCats.delete(cat);
        else this.disabledCats.add(cat);
        this.saveFilterState();
      });
      const swatch = document.createElement("span");
      Object.assign(swatch.style, { width: "10px", height: "10px", borderRadius: "2px", background: this.catColor(cat), display: "inline-block", flex: "0 0 auto" });
      const lbl = document.createElement("span");
      lbl.textContent = `${catLabel} (${total})`;
      lbl.style.flex = "1";
      const caret = document.createElement("span");
      caret.textContent = "\u25B8";
      caret.style.opacity = "0.6";
      const sub = document.createElement("div");
      Object.assign(sub.style, { display: "none", paddingLeft: "20px", marginTop: "2px" });
      const sortedNames = [...names.keys()].sort();
      for (const nm of sortedNames) {
        const nrow = document.createElement("div");
        Object.assign(nrow.style, { display: "flex", alignItems: "center", gap: "6px" });
        const ncb = this.makeCheckbox(this.nameEnabled(cat, nm), (v) => {
          const k = `${cat}:${nm}`;
          if (v) this.disabledNames.delete(k);
          else this.disabledNames.add(k);
          this.saveFilterState();
        });
        const nlbl = document.createElement("span");
        nlbl.textContent = `${this.prettify(nm)} (${names.get(nm)})`;
        nrow.append(ncb, nlbl);
        sub.appendChild(nrow);
      }
      const toggleExpand = () => {
        sub.style.display = sub.style.display === "none" ? "block" : "none";
        caret.textContent = sub.style.display === "none" ? "\u25B8" : "\u25BE";
      };
      caret.onclick = toggleExpand;
      lbl.onclick = toggleExpand;
      head.append(cb, swatch, lbl, caret);
      row.append(head, sub);
      this.panelEl.appendChild(row);
    }
  }
  makeCheckbox(checked, onChange) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.style.cursor = "pointer";
    cb.onchange = () => onChange(cb.checked);
    return cb;
  }
  makeToggle(label, checked, onChange, color) {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" });
    const cb = this.makeCheckbox(checked, onChange);
    const sw = document.createElement("span");
    Object.assign(sw.style, { width: "10px", height: "10px", borderRadius: "50%", background: color, display: "inline-block" });
    const l = document.createElement("span");
    l.textContent = label;
    row.append(cb, sw, l);
    return row;
  }
  installKeyHandler() {
    window.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "m" || e.key === "M") this.toggleMap(this.mapOverlay?.style.display === "none");
    }, { capture: true });
  }
  installCanvasControls() {
    const canvas = this.mapCanvas;
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      this.zoom = Math.max(0.5, Math.min(this.zoom * factor, 48));
    });
    let dragging = false, moved = false, lastX = 0, lastY = 0;
    canvas.addEventListener("mousedown", (e) => {
      dragging = true;
      moved = false;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = "grabbing";
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
      canvas.style.cursor = "grab";
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 2) {
          moved = true;
          this.followPlayer = false;
        }
        lastX = e.clientX;
        lastY = e.clientY;
        this.centerX -= dx / this.zoom;
        this.centerZ -= dy / this.zoom;
      }
      const rect = canvas.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        this.hoverPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      } else {
        this.hoverPos = null;
      }
    });
    canvas.addEventListener("click", () => {
      if (moved || !this.hoverPos) return;
      const hit = this.pickHit(this.hoverPos.x, this.hoverPos.y);
      if (hit) {
        this.centerX = hit.wx;
        this.centerZ = hit.wz;
        this.followPlayer = false;
      }
    });
  }
  pickHit(x, y) {
    let best = null, bestD = Infinity;
    for (const h of this.hitTargets) {
      const d = (h.sx - x) ** 2 + (h.sy - y) ** 2;
      const rr = (h.r + 4) ** 2;
      if (d <= rr && d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }
  toggleMap(show) {
    if (!this.mapOverlay) return;
    if (show) {
      this.mapOverlay.style.display = "flex";
      this.followPlayer = true;
      this.refreshData();
      this.startRenderLoop();
    } else {
      this.mapOverlay.style.display = "none";
      this.persistStores(true);
      if (this.renderInterval) {
        clearInterval(this.renderInterval);
        this.renderInterval = null;
      }
    }
  }
  startRenderLoop() {
    if (this.renderInterval) return;
    this.renderInterval = setInterval(() => this.renderFrame(), 80);
    this.renderFrame();
  }
  rebuildWorldCanvas(cm) {
    const mapW = cm.mapWidth | 0;
    const mapH = cm.mapHeight | 0;
    if (!mapW || !mapH || typeof cm.getTilesForMinimap !== "function") return false;
    if (!this.worldCanvas || this.worldW !== mapW || this.worldH !== mapH) {
      this.worldCanvas = document.createElement("canvas");
      this.worldCanvas.width = mapW;
      this.worldCanvas.height = mapH;
      this.worldW = mapW;
      this.worldH = mapH;
      this.worldCtx = this.worldCanvas.getContext("2d", { willReadFrequently: true });
      this.lastPaintedSize = -1;
    }
    const painted = cm.tilePaintedEntries?.size ?? 0;
    const now = performance.now();
    const grew = painted !== this.lastPaintedSize;
    const haveMap = this.lastPaintedSize >= 0;
    if (haveMap && now - this.lastRebuild < 600) return true;
    if (haveMap && !grew && now - this.lastRebuild < 1500) return true;
    this.lastPaintedSize = painted;
    this.lastRebuild = now;
    const RADIUS_CAP = 768;
    const fullRadius = Math.ceil(Math.max(mapW, mapH) / 2) + 2;
    const radius = Math.min(fullRadius, RADIUS_CAP);
    let cx, cz;
    if (radius >= fullRadius) {
      cx = mapW / 2;
      cz = mapH / 2;
    } else {
      const p = this.getPlayerPos();
      cx = p ? p.x : mapW / 2;
      cz = p ? p.z : mapH / 2;
    }
    let buf;
    try {
      buf = cm.getTilesForMinimap(cx, cz, radius);
    } catch {
      return this.lastPaintedSize >= 0;
    }
    if (!buf) return false;
    const { tiles, walls, roofs, textured, voidTiles, overrideColors, hasOverride, size, startX, startZ } = buf;
    const T = _WorldMapPlugin.T, TC = _WorldMapPlugin.TYPE_COLOR, TEX = _WorldMapPlugin.TEXTURED_COLOR, ROOF = _WorldMapPlugin.ROOF_COLOR;
    const ctx = this.worldCtx;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let f = 0; f < size; f++) {
      for (let m = 0; m < size; m++) {
        const b = f * size + m;
        const worldX = startX + m, worldZ = startZ + f;
        if (worldX < 0 || worldX >= mapW || worldZ < 0 || worldZ >= mapH) continue;
        if (voidTiles[b]) continue;
        const type = tiles[b], wallRaw = walls[b];
        const isWall = type === T.WALL || (wallRaw & 5) === 5 || (wallRaw & 10) === 10;
        const isRoof = !isWall && roofs[b] === 1;
        const isTex = !isWall && textured[b] === 1;
        let col = TC[type] || TC[T.GRASS];
        if (isTex) col = TEX;
        if (hasOverride[b] === 1) {
          const e = b * 3;
          col = [overrideColors[e], overrideColors[e + 1], overrideColors[e + 2]];
        }
        if (isRoof) col = ROOF;
        let r = col[0], g = col[1], bl = col[2];
        if (isWall) {
          r = r * 0.55 | 0;
          g = g * 0.55 | 0;
          bl = bl * 0.55 | 0;
        }
        const o = b * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = bl;
        data[o + 3] = 255;
      }
    }
    const tmp = document.createElement("canvas");
    tmp.width = size;
    tmp.height = size;
    const tctx = tmp.getContext("2d");
    if (!tctx) return false;
    tctx.putImageData(img, 0, 0);
    ctx.drawImage(tmp, startX, startZ);
    return true;
  }
  renderFrame() {
    if (!this.mapCanvas) return;
    this.refreshData();
    const cm = this.getChunkManager();
    const display = this.mapCanvas;
    const ctx = display.getContext("2d");
    if (!ctx) return;
    const rect = display.getBoundingClientRect();
    const dw = Math.max(1, Math.floor(rect.width));
    const dh = Math.max(1, Math.floor(rect.height));
    if (display.width !== dw || display.height !== dh) {
      display.width = dw;
      display.height = dh;
    }
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, dw, dh);
    if (!cm) {
      this.setStatus("Waiting for game\u2026 (log in to view the map)");
      return;
    }
    const built = this.rebuildWorldCanvas(cm);
    if (!built || !this.worldCanvas) {
      this.setStatus("Map data not loaded yet\u2026");
      return;
    }
    const player = this.getPlayerPos();
    if (this.followPlayer && player) {
      this.centerX = player.x;
      this.centerZ = player.z;
    } else if (this.centerX === 0 && this.centerZ === 0) {
      this.centerX = this.worldW / 2;
      this.centerZ = this.worldH / 2;
    }
    const z = this.zoom;
    const srcLeft = this.centerX - dw / (2 * z);
    const srcTop = this.centerZ - dh / (2 * z);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(-srcLeft * z, -srcTop * z);
    ctx.scale(z, z);
    ctx.drawImage(this.worldCanvas, 0, 0);
    ctx.restore();
    this.drawMarkers(ctx, dw, dh, srcLeft, srcTop, z);
    if (player) this.drawPlayerMarker(ctx, (player.x - srcLeft) * z, (player.z - srcTop) * z);
    this.updateTooltip();
    const objCount = this.objectStore.size;
    let sightCount = 0;
    for (const m of this.npcStore.values()) sightCount += m.size;
    this.setStatus(`obj: ${objCount} | npc seen: ${sightCount} | live: ${this.liveNpcs.length} | zoom ${z.toFixed(1)}x`);
  }
  drawMarkers(ctx, dw, dh, srcLeft, srcTop, z) {
    this.hitTargets = [];
    const pad = 16;
    const baseR = Math.max(3, Math.min(z * 0.55, 9));
    const showLabels = z >= 9;
    const q = this.searchStr;
    const inView = (sx, sy) => sx >= -pad && sx <= dw + pad && sy >= -pad && sy <= dh + pad;
    if (this.showNpcSightings) {
      for (const [defId, m] of this.npcStore) {
        const first = m.values().next().value;
        const name = first?.name ?? "";
        if (q && !name.toLowerCase().includes(q)) continue;
        ctx.fillStyle = "rgba(255,90,90,0.28)";
        for (const s of m.values()) {
          if (this.liveNpcKeys.has(`${defId}:${s.x},${s.z}`)) continue;
          const sx = (s.x + 0.5 - srcLeft) * z, sy = (s.z + 0.5 - srcTop) * z;
          if (!inView(sx, sy)) continue;
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(2, baseR * 0.5), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    for (const o of this.objectStore.values()) {
      if (!this.nameEnabled(o.category, o.name)) continue;
      if (q && !(o.name.toLowerCase().includes(q) || o.category.toLowerCase().includes(q))) continue;
      const sx = (o.x + 0.5 - srcLeft) * z, sy = (o.z + 0.5 - srcTop) * z;
      if (!inView(sx, sy)) continue;
      const color = this.catColor(o.category);
      this.drawShape(ctx, this.catShape(o.category), sx, sy, baseR, color, o.depleted ? 0.4 : 1);
      this.hitTargets.push({ sx, sy, r: baseR, label: this.prettify(o.name), sub: `${this.prettify(o.category)} \u2022 ${o.x},${o.z}${o.depleted ? " \u2022 depleted" : ""}`, wx: o.x + 0.5, wz: o.z + 0.5 });
      if (showLabels) this.drawLabel(ctx, this.prettify(o.name), sx, sy - baseR - 2);
    }
    if (this.showLiveNpcs) {
      for (const n of this.liveNpcs) {
        if (this.disabledNames.has(`${_WorldMapPlugin.NPC_CAT}:${n.name}`) || this.disabledCats.has(_WorldMapPlugin.NPC_CAT)) continue;
        if (q && !n.name.toLowerCase().includes(q)) continue;
        const sx = (n.x - srcLeft) * z, sy = (n.z - srcTop) * z;
        if (!inView(sx, sy)) continue;
        this.drawShape(ctx, "triangle", sx, sy, baseR + 1, "#ff5555", 1);
        this.hitTargets.push({ sx, sy, r: baseR + 1, label: this.prettify(n.name), sub: `NPC${n.level != null ? ` \u2022 lvl ${n.level}` : ""} \u2022 ${Math.round(n.x)},${Math.round(n.z)}`, wx: n.x, wz: n.z });
        if (showLabels) this.drawLabel(ctx, `${this.prettify(n.name)}${n.level != null ? ` (${n.level})` : ""}`, sx, sy - baseR - 4);
      }
    }
    if (this.showPlayers) {
      for (const p of this.players) {
        const sx = (p.x - srcLeft) * z, sy = (p.z - srcTop) * z;
        if (!inView(sx, sy)) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, baseR * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = "#5dd5ff";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#0a3a4a";
        ctx.stroke();
        if (p.name && showLabels) this.drawLabel(ctx, p.name, sx, sy - baseR - 2, "#bdecff");
        this.hitTargets.push({ sx, sy, r: baseR, label: p.name || "Player", sub: `Player \u2022 ${Math.round(p.x)},${Math.round(p.z)}`, wx: p.x, wz: p.z });
      }
    }
  }
  drawShape(ctx, shape, x, y, r, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (shape === "circle") {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    } else if (shape === "square") {
      ctx.rect(x - r, y - r, r * 2, r * 2);
    } else if (shape === "diamond") {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
    } else {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  drawLabel(ctx, text, x, y, color = "#fff") {
    ctx.save();
    ctx.font = "11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }
  drawPlayerMarker(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#000";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = "#2ecc71";
    ctx.fill();
  }
  updateTooltip() {
    if (!this.tooltipEl) return;
    if (!this.hoverPos) {
      this.tooltipEl.style.display = "none";
      return;
    }
    const hit = this.pickHit(this.hoverPos.x, this.hoverPos.y);
    if (!hit) {
      this.tooltipEl.style.display = "none";
      return;
    }
    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.left = `${this.hoverPos.x}px`;
    this.tooltipEl.style.top = `${this.hoverPos.y}px`;
    this.tooltipEl.innerHTML = `<b>${hit.label}</b><br><span style="opacity:0.75">${hit.sub}</span>`;
  }
  jumpToNearestMatch() {
    const q = this.searchStr;
    if (!q) return;
    const player = this.getPlayerPos() ?? { x: this.centerX, z: this.centerZ };
    let best = null, bestD = Infinity;
    const consider = (x, z) => {
      const d = (x - player.x) ** 2 + (z - player.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x, z };
      }
    };
    for (const o of this.objectStore.values()) {
      if (this.nameEnabled(o.category, o.name) && (o.name.toLowerCase().includes(q) || o.category.toLowerCase().includes(q))) consider(o.x, o.z);
    }
    for (const n of this.liveNpcs) if (n.name.toLowerCase().includes(q)) consider(n.x, n.z);
    if (this.showNpcSightings) {
      for (const m of this.npcStore.values()) {
        const first = m.values().next().value;
        if (first && first.name.toLowerCase().includes(q)) for (const s of m.values()) consider(s.x, s.z);
      }
    }
    if (best) {
      this.centerX = best.x;
      this.centerZ = best.z;
      this.followPlayer = false;
      this.zoom = Math.max(this.zoom, 10);
    }
  }
  setStatus(text) {
    if (this.statusEl) this.statusEl.innerText = text;
  }
};
_WorldMapPlugin.NPC_CAT = "__npc__";
_WorldMapPlugin.MAX_SIGHTINGS_PER_NPC = 240;
// ── Category styling (defaults + dynamic fallback for new categories) ──────────
_WorldMapPlugin.CAT_COLOR = {
  tree: "#3ea63e",
  rock: "#9a8f86",
  bank: "#f1c40f",
  furnace: "#e67e22",
  cookingrange: "#e74c3c",
  fishingspot: "#3498db",
  crop: "#d4ac0d",
  chest: "#a9783c",
  door: "#c9a66b",
  ladder: "#ecf0f1",
  __npc__: "#ff5555"
};
// ── Terrain rendering ─────────────────────────────────────────────────────────
_WorldMapPlugin.T = { GRASS: 0, DIRT: 1, STONE: 2, WATER: 3, WALL: 4, SAND: 5, WOOD: 6, MUD: 7 };
_WorldMapPlugin.TYPE_COLOR = {
  0: [62, 140, 46],
  1: [138, 104, 60],
  2: [130, 124, 114],
  3: [44, 88, 142],
  4: [62, 140, 46],
  5: [196, 170, 106],
  6: [116, 82, 48],
  7: [62, 140, 46]
};
_WorldMapPlugin.TEXTURED_COLOR = [138, 116, 82];
_WorldMapPlugin.ROOF_COLOR = [96, 64, 34];
var WorldMapPlugin = _WorldMapPlugin;
export {
  WorldMapPlugin as default
};
