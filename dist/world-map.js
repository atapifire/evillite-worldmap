// ../evillite-worldmap/src/WorldMapPlugin.ts
import { Plugin } from "@evillite/core/src/interfaces/highlite/plugin/plugin.class";
import { SettingsTypes } from "@evillite/core/src/interfaces/highlite/plugin/pluginSettings.interface";
import { PluginAssetCache } from "@evillite/core/src/utilities/pluginAssetCache";
import { ModelIconCache } from "@evillite/core/src/utilities/modelIconCache";
var _WorldMapPlugin = class _WorldMapPlugin extends Plugin {
  // Bump when the render output changes (camera angle, URL fix, …) to invalidate &
  // regenerate every persisted icon. Old-version keys are purged on load.
  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  /** The core only runs init()/start() once logged in, but registerPlugin constructs the
   *  instance at page load. We register the sidebar icon + M-key handler here (construction)
   *  so the map is reachable when logged OUT too — it opens the persisted offline bundle.
   *  The live data collection / overlay still starts on login via start(). */
  constructor() {
    super();
    this.pluginName = "World Map";
    this.author = "HighLite";
    this.settings = {
      enable: {
        text: "Enable World Map",
        type: SettingsTypes.checkbox,
        value: true,
        callback: this.onSettingsChanged_enabled.bind(this)
      },
      popoutMode: {
        text: "Open Chat Links in Popout Window",
        type: SettingsTypes.checkbox,
        value: true
      }
    };
    // ── DOM ─────────────────────────────────────────────────────────────────────
    this.statusEl = null;
    // ── Offscreen terrain canvas (1px per tile) ───────────────────────────────────
    this.worldCanvas = null;
    this.worldCtx = null;
    this.worldW = 0;
    this.worldH = 0;
    this.worldWalls = new Uint8Array(0);
    // Invalidates in-flight async terrain seeds when the canvas is recreated (floor/size change).
    this.worldSeedToken = 0;
    // Throttle for re-baking the shipped terrain cache in dev (ms timestamp).
    this.lastTerrainBake = 0;
    // Tracks live connectivity so we can self-heal the map on reconnect after an AFK kick.
    this.wasOnline = false;
    this.isStarted = false;
    this.mapMenuIcon = null;
    // Detached map window (a separate OS window the user can move/resize while playing).
    this.mapWindowOpen = false;
    this.mapWindowTimer = null;
    this.mapWindowFullTimer = null;
    this.mwCloseHooked = false;
    // Perf: the terrain PNG (toDataURL) is a ~100ms main-thread block; cache it and only regenerate
    // when the explored terrain actually changed. lastFullSig gates the heavy full-snapshot push so
    // it doesn't run every 7s for no reason (which froze the game tick → click-to-move "slingshot").
    this.terrainUrl = "";
    this.terrainUrlSig = "";
    this.lastFullSig = "";
    this.mapTerrainTimer = null;
    this.terrainEncoding = false;
    // ── One viewer, two hosts ─────────────────────────────────────────────────────
    // The SAME HTML viewer (buildMapWindowHtml) runs either in a detached OS window
    // ('window') or an in-page iframe docked over the game ('overlay'). mapMode is the
    // user's remembered preference; the active host is whichever is currently open.
    this.mapMode = "window";
    this.overlayEl = null;
    // overlay host container
    this.overlayFrame = null;
    this.overlayShadow = null;
    // shadow root the viewer runs inside
    this.overlayMsgHooked = false;
    // ── View state (tile units) ───────────────────────────────────────────────────
    this.currentFloor = 0;
    // ── Discovered/accumulated data ───────────────────────────────────────────────
    /** Persistent object store for the current map: key `${x},${z},${floor},${defId}`. */
    this.objectStore = /* @__PURE__ */ new Map();
    /** Persistent NPC sightings: defId -> (key `${x},${z}` -> sighting). */
    this.npcStore = /* @__PURE__ */ new Map();
    this.liveNpcs = [];
    this.liveNpcKeys = /* @__PURE__ */ new Set();
    /** Per-session last-known position by entity id (unique per spawned NPC this session,
     *  NOT stable across relogins). Lets us hand a live NPC off to an exact "last known"
     *  marker when it leaves broadcast — and back to live when it returns — instead of the
     *  fuzzy proximity dedup. Cleared on map change; persisted cross-session via npcStore. */
    this.sessionNpcs = /* @__PURE__ */ new Map();
    this.players = [];
    this.minimapMarkers = [];
    this.mapId = "";
    this.lastDataRefresh = 0;
    this.lastSave = 0;
    this.storeDirty = false;
    this.liveEphemeral = [];
    this.ephemeralPurged = false;
    // ── Filter state ──────────────────────────────────────────────────────────────
    this.disabledCats = /* @__PURE__ */ new Set();
    this.disabledNames = /* @__PURE__ */ new Set();
    // `${category}:${name}`
    this.showLiveNpcs = true;
    this.showNpcSightings = true;
    this.showPlayers = true;
    this.labelsEnabled = true;
    this.showMinimapMarkers = true;
    this.warmedUp = false;
    this._mmDumped = false;
    // One-time import of pre-plugin.data localStorage (`evilitemap:*`). Best-effort:
    // the old launch-time clearStorageData() wiped this each boot, so there's at most
    // one session to recover; once imported we drop the legacy keys.
    this.legacyMigrated = false;
    /** The game's dark-stone tile, rotated 90° (brick courses horizontal), as a data URL.
     *  Baked once in the game renderer (same-origin) so the detached map window — a file://
     *  page that can't rotate the cross-origin texture itself without tainting — can reuse it. */
    this.stoneTexBaked = null;
    this.keyHandlerInstalled = false;
    // Df — matches game exactly
    // Wall direction bitmask (F enum in the game): N=1, E=2, S=4, W=8 (Clockwise).
    // This aligns perfectly with the game's checks: (wf & 5) === 5 is N+S, (wf & 10) === 10 is E+W.
    // Wall-edge line color — RGB(220,216,200): warm cream, same as game minimap white lines.
    this.lastPaintedSize = -1;
    this.lastRebuild = 0;
    // ── Model-thumbnail icons (Phase 1) ───────────────────────────────────────────
    // Render the game's own 3D models to small sprites by reusing its already-loaded
    // Babylon instance (dynamically imported from the page's babylon-core module).
    // Object model files come from the bundle's `Cs` table (defId -> files), NPCs from
    // the `Lu` table (defId -> file); both are parsed out of window.__eqSourceCode.
    // Icons render lazily on demand, are cached, and replace the colour/shape markers.
    this.iconsEnabled = true;
    this.iconCache = /* @__PURE__ */ new Map();
    /** Rendered model icons live in the CORE-managed shared 'model-icons' namespace
     *  (data/model-icons.json) so any plugin can read them — the map is just the
     *  producer (it can render the 3D models). See ModelIconCache. */
    this.iconCacheStore = new ModelIconCache();
    /** Build-committed prebake of explored terrain (per map+floor), via the same core
     *  asset cache (data/world-map-terrain.json). Packaged users load a full map up
     *  front; in dev it re-bakes as you explore so the shipped cache can be updated. */
    this.terrainCacheStore = new PluginAssetCache("world-map-terrain");
    /** In-memory copy of the shipped terrain prebake (key `${id}:${floor}` -> bundle JSON),
     *  loaded once so the offline snapshot can fall back to it synchronously when the user's
     *  localStorage bundle is missing or has blank/weak terrain (e.g. a fresh install that
     *  never logged in, or a force-logout that wiped the live terrain). */
    this.shippedBundles = null;
    this.iconFailed = /* @__PURE__ */ new Set();
    this.iconPending = /* @__PURE__ */ new Set();
    this.iconQueue = [];
    this.iconRendering = false;
    // Back-off when model fetches start returning 401/403 (the EvilQuest session token lapsed):
    // stop hammering the server so we don't spam failures while the token refresh kicks in.
    this.iconAuthFailStreak = 0;
    this.iconQueuePausedUntil = 0;
    /** Representative ready icon per object category / `cat name` — drives the
     *  legend "parent" icons and the fallback for childless members. */
    this.catRepIcon = /* @__PURE__ */ new Map();
    this.nameRepIcon = /* @__PURE__ */ new Map();
    /** A representative object per category / `cat name`, so the legend can render an
     *  icon for it even before you pan near one on the map. */
    this.catSampleObj = /* @__PURE__ */ new Map();
    this.nameSampleObj = /* @__PURE__ */ new Map();
    /** npc display name -> a defId, so legend rows can find/queue an icon. */
    this.npcNameDef = /* @__PURE__ */ new Map();
    /** Legend icon holders to keep refreshed as icons render in. */
    this.objModelFiles = null;
    this.npcModelFiles = null;
    /** Resolved model file per `${kind}:${defId}` (null = def loaded but has no .glb). */
    this.modelFileCache = /* @__PURE__ */ new Map();
    /** defId -> the set of assetIds we've seen for it. When it's exactly one, distant
     *  objects of that defId (no mesh loaded) can reuse that model for their icon. */
    this.defIdAssets = /* @__PURE__ */ new Map();
    this.diagDumped = false;
    this.bjs = null;
    this.bjsState = "idle";
    this.lastIconDiag = "";
    this.offEngine = null;
    this.offCanvas = null;
    // The offscreen Babylon engine accumulates GPU memory across GLB loads (textures/effects
    // that scene.dispose() doesn't fully reclaim). Recycle it every N renders to bound RAM
    // while STILL rendering every object (so the dev cache builds a complete map).
    this.rendersSinceEngineReset = 0;
    this.probedObjCats = /* @__PURE__ */ new Set();
    this.probeDeadline = 0;
    /** True while renderAllIcons() is bulk-baking, so the queue's MAX_ICON_QUEUE trim
     *  is suspended (we WANT to render everything, not just what's visible). */
    this.bulkRendering = false;
    this.mmIconCache = /* @__PURE__ */ new Map();
    try {
      this.installKeyHandler();
      this.registerSidebarIcon();
    } catch {
    }
    try {
      void this.reattachMapWindow();
    } catch {
    }
    try {
      void this.loadShippedBundles();
    } catch {
    }
    try {
      void this.bakeStoneTexture();
    } catch {
    }
  }
  init() {
    this.info("World Map Plugin initializing.");
    this.settings.enable.value = true;
    this.loadFilterState();
    this.setupChatHook();
    this.start();
  }
  setupChatHook() {
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList") {
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node;
              if (el.closest && el.closest("#chat-log")) {
                this.processChatNode(el);
              }
            }
          }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      const chatLog = document.getElementById("chat-log");
      if (chatLog) this.processChatNode(chatLog);
    }, 1e3);
  }
  processChatNode(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let currentNode;
    while (currentNode = walker.nextNode()) {
      textNodes.push(currentNode);
    }
    const pattern = /\((-?\d+),\s*(-?\d+)\)(?:\[(.*?)\])?/g;
    for (const node of textNodes) {
      const text = node.nodeValue;
      if (!text || !pattern.test(text)) continue;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
        }
        const x = parseInt(match[1], 10);
        const z = parseInt(match[2], 10);
        const label = match[3];
        const link = document.createElement("span");
        link.className = "map-link";
        link.textContent = label ? label : `(${x}, ${z})`;
        link.title = label ? `Click to view (${x}, ${z}) on map` : "Click to view on map";
        Object.assign(link.style, {
          color: "#4da6ff",
          cursor: "pointer",
          textDecoration: "underline"
        });
        link.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!this.viewerOpen()) this.openMap();
          const go = () => this.pushToViewer({ goTo: { x, z } });
          setTimeout(go, 120);
          setTimeout(go, 450);
          setTimeout(go, 900);
        });
        fragment.appendChild(link);
        lastIndex = pattern.lastIndex;
      }
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
      }
      if (node.parentNode) {
        node.parentNode.replaceChild(fragment, node);
      }
    }
  }
  start() {
    if (this.isStarted) return;
    this.isStarted = true;
    this.info("World Map Plugin started.");
    this.installKeyHandler();
    this.registerSidebarIcon();
    this.warmUp();
  }
  /** Pre-load the icon system + map data in the background once the player is in-world, so
   *  the first time the map opens it's already populated — instead of showing placeholder
   *  dots for a moment while the prebaked icon cache loads and the world canvas builds. */
  async warmUp(attempt = 0) {
    if (this.warmedUp || !this.isStarted) return;
    const cm = this.getChunkManager();
    if (!cm || !this.gm?.scene) {
      if (attempt < 90) setTimeout(() => this.warmUp(attempt + 1), 1e3);
      return;
    }
    this.warmedUp = true;
    try {
      this.bakeStoneTexture();
      await this.initIconSystem();
      void this.renderAllIcons();
      this.refreshData();
      this.rebuildWorldCanvas(cm);
      setTimeout(() => this.refreshData(), 1500);
      if (this.mapWindowOpen) {
        const ipc = window.electron?.ipcRenderer;
        const s = this.buildMapSnapshot();
        if (s) ipc?.send("map-window:update", { full: s, p: s.p });
      }
      this.info("warm-up complete \u2014 map ready to open instantly.");
    } catch {
    }
  }
  stop() {
    this.isStarted = false;
    this.info("World Map Plugin stopped.");
    this.persistStores(true);
    this.stopMapWindowUpdates();
    if (this.overlayEl) this.closeOverlayHost();
    this.unregisterSidebarIcon();
    this.warmedUp = false;
  }
  /** Add a map icon to the plugin sidebar (highlite_bar). Clicking it toggles the map
   *  like pressing M. The PanelManager is a core singleton created before plugins start;
   *  if it isn't ready yet (race on cold start), retry shortly. */
  registerSidebarIcon(attempt = 0) {
    if (this.mapMenuIcon) return;
    const pm = document.highlite?.managers?.PanelManager;
    if (!pm || typeof pm.requestMenuItem !== "function") {
      if (attempt < 20) setTimeout(() => this.registerSidebarIcon(attempt + 1), 400);
      return;
    }
    try {
      const [iconEl] = pm.requestMenuItem(_WorldMapPlugin.MENU_ICON, "World Map");
      this.mapMenuIcon = iconEl;
      this.mapMenuIcon.title = "World Map (M)";
      this.mapMenuIcon.onclick = (e) => {
        e.stopPropagation();
        this.openMapWindow();
      };
    } catch (err) {
      this.warn("sidebar icon registration failed: " + (err?.message ?? err));
    }
  }
  unregisterSidebarIcon() {
    const pm = document.highlite?.managers?.PanelManager;
    try {
      if (pm && this.mapMenuIcon) pm.removeMenuItem(_WorldMapPlugin.MENU_ICON);
    } catch {
    }
    this.mapMenuIcon = null;
  }
  onSettingsChanged_enabled() {
    if (this.settings.enable.value) this.start();
    else this.stop();
  }
  // ── Game data access (all by stable semantic names) ───────────────────────────
  get gm() {
    return this.gameHooks?.GameManager?.Instance ?? window.gm ?? null;
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
  /** Stable category shape shown while an object's own icon is still rendering (or its
   *  mesh hasn't loaded near yet) — category-coloured, deterministic, so it never churns. */
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
  /** Turn a model assetId (Crate1, OnePersonBed1, CopperRock2, bush2) into a readable
   *  label (Crate, One Person Bed, Copper Rock, Bush) — used for objects whose def name
   *  is generic ("Scenery", "Door"), since EvilQuest only stores the real identity in the
   *  per-placement assetId. Trailing version numbers are dropped so variants group. */
  prettifyAsset(a) {
    return (a || "").replace(/\.(glb|gltf)$/i, "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/\s+\d+$/, "").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // ── Data collection + accumulation ────────────────────────────────────────────
  /** Detect a reconnect (offline→online). The 5-min AFK kick boots you and the game
   *  tears the world down and later rebuilds it; the in-memory worldCanvas is then stale
   *  (or was repainted blank mid-teardown). On the offline→online edge, drop the terrain
   *  so the next rebuild recreates it fresh and re-seeds from the saved caches — this makes
   *  an already-open map window self-heal without the user closing and reopening it. */
  syncConnectivity() {
    const cm = this.getChunkManager();
    const live = !!(cm && cm.mapWidth | 0 && (cm.tilePaintedEntries?.size | 0) > 0) && !!this.getPlayerPos();
    if (live && !this.wasOnline) {
      this.worldCanvas = null;
      this.lastPaintedSize = -1;
      this.lastRebuild = 0;
    }
    this.wasOnline = live;
  }
  refreshData() {
    const now = performance.now();
    if (now - this.lastDataRefresh < 500) return;
    this.lastDataRefresh = now;
    this.syncConnectivity();
    const gm = this.gm;
    if (!gm) return;
    const id = this.getMapId();
    if (id !== this.mapId) {
      this.persistStores(true);
      this.mapId = id;
      this.objectStore.clear();
      this.npcStore.clear();
      this.sessionNpcs.clear();
      this.catSampleObj.clear();
      this.nameSampleObj.clear();
      this.catRepIcon.clear();
      this.nameRepIcon.clear();
      this.defIdAssets.clear();
      this._mmDumped = false;
      this.loadStores();
    }
    this.collectObjects();
    this.collectNpcs();
    this.collectPlayers();
    this.collectMinimapMarkers();
    if (!this.diagDumped && this.bjsState === "ready" && this.objectStore.size > 0 && this.npcStore.size > 0) {
      this.dumpModelDiag();
    }
    this.probeNewObjectCategories();
    if (this.storeDirty && now - this.lastSave > 4e3) this.persistStores();
  }
  /** True for transient, player-/event-created objects that must not be persisted (fire). */
  isEphemeralObject(name, assetId) {
    return /^fire$/i.test(name) || /^fire$/i.test(assetId);
  }
  collectObjects() {
    const gm = this.gm;
    const wod = gm.worldObjectDefs;
    const defs = gm.objectDefsCache;
    if (!wod || !defs) return;
    this.liveEphemeral = [];
    if (!this.ephemeralPurged) {
      this.ephemeralPurged = true;
      for (const [k, o] of this.objectStore) {
        if (this.isEphemeralObject(o.name, o.assetId || "")) {
          this.objectStore.delete(k);
          this.storeDirty = true;
        }
      }
    }
    const models = this.getWorldObjectModels();
    for (const [woKey, rec] of wod) {
      if (!rec || typeof rec.x !== "number" || typeof rec.z !== "number") continue;
      const def = defs.get(rec.defId);
      const category = (def?.category ?? "object") + "";
      const defName = (def?.name ?? `#${rec.defId}`) + "";
      const floor = rec.floor ?? 0;
      const model = models?.get(woKey);
      const meta = model?.metadata;
      let assetId = (rec.metadata?.assetId ?? meta?.assetId ?? rec.assetId ?? "") + "";
      if (!assetId && model) assetId = this.assetIdFromModel(model);
      const placedName = (meta?.placedName ?? "") + "";
      const specificName = category === "scenery" && assetId ? this.prettifyAsset(assetId) : "";
      const name = placedName || specificName || defName;
      const key = `${rec.x},${rec.z},${floor},${rec.defId}`;
      if (this.isEphemeralObject(name, assetId)) {
        this.liveEphemeral.push({ defId: rec.defId, category, name, x: rec.x, z: rec.z, floor, depleted: !!rec.depleted, assetId });
        if (this.objectStore.has(key)) {
          this.objectStore.delete(key);
          this.storeDirty = true;
        }
        continue;
      }
      const existing = this.objectStore.get(key);
      const depleted = !!rec.depleted;
      let stored = existing;
      if (!existing) {
        stored = { defId: rec.defId, category, name, x: rec.x, z: rec.z, floor, depleted, assetId };
        this.objectStore.set(key, stored);
        this.storeDirty = true;
      } else {
        if (existing.depleted !== depleted) existing.depleted = depleted;
        if (!existing.assetId && assetId) existing.assetId = assetId;
        const better = placedName || specificName;
        if (better && existing.name !== better) {
          existing.name = better;
          this.storeDirty = true;
        }
      }
      if (stored && stored.assetId) {
        const ex = this.catSampleObj.get(category);
        if (!ex || !ex.assetId) this.catSampleObj.set(category, stored);
        const nk = category + " " + stored.name;
        const exn = this.nameSampleObj.get(nk);
        if (!exn || !exn.assetId) this.nameSampleObj.set(nk, stored);
        let set = this.defIdAssets.get(rec.defId);
        if (!set) {
          set = /* @__PURE__ */ new Set();
          this.defIdAssets.set(rec.defId, set);
        }
        set.add(stored.assetId);
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
      if (!this.npcNameDef.has(name)) this.npcNameDef.set(name, defId);
      const se = this.sessionNpcs.get(id);
      if (se) {
        se.defId = defId;
        se.name = name;
        se.x = x;
        se.z = z;
        se.floor = floor;
        se.level = level;
        se.seen = Date.now();
      } else {
        if (this.sessionNpcs.size >= _WorldMapPlugin.MAX_SESSION_NPCS) {
          const oldest = this.sessionNpcs.keys().next().value;
          if (oldest !== void 0) this.sessionNpcs.delete(oldest);
        }
        this.sessionNpcs.set(id, { id, defId, name, x, z, floor, level, seen: Date.now() });
      }
      const rx = Math.floor(x) + 0.5, rz = Math.floor(z) + 0.5;
      let perDef = this.npcStore.get(defId);
      if (!perDef) {
        perDef = /* @__PURE__ */ new Map();
        this.npcStore.set(defId, perDef);
      }
      const skey = `${rx},${rz}`;
      const existing = perDef.get(skey);
      if (!existing) {
        if (perDef.size >= _WorldMapPlugin.MAX_SIGHTINGS_PER_NPC) {
          const first = perDef.keys().next().value;
          if (first !== void 0) perDef.delete(first);
        }
        perDef.set(skey, { defId, name, x: rx, z: rz, level, floor, seen: Date.now() });
        this.storeDirty = true;
      } else {
        existing.seen = Date.now();
        if (existing.floor === void 0) existing.floor = floor;
      }
    }
    const px = ents.player?.x, pz = ents.player?.z;
    if (px != null && pz != null) {
      const VERIFY_DIST = 35 * 35;
      for (const [id, s] of this.sessionNpcs) {
        if ((s.floor ?? 0) === this.currentFloor) {
          const dx = s.x - px, dz = s.z - pz;
          if (dx * dx + dz * dz < VERIFY_DIST) {
            if (!this.liveNpcs.some((n) => n.id === id)) {
              this.sessionNpcs.delete(id);
            }
          }
        }
      }
      for (const [defId, clusters] of this.npcStore) {
        for (const [skey, m] of clusters) {
          if ((m.floor ?? 0) === this.currentFloor) {
            const dx = m.x - px, dz = m.z - pz;
            if (dx * dx + dz * dz < VERIFY_DIST) {
              const hasLive = this.liveNpcs.some((n) => n.defId === defId && Math.pow(n.x - m.x, 2) + Math.pow(n.z - m.z, 2) < 225);
              if (!hasLive) {
                clusters.delete(skey);
                this.storeDirty = true;
              }
            }
          }
        }
        if (clusters.size === 0) this.npcStore.delete(defId);
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
  collectMinimapMarkers() {
    const gm = this.gm;
    let raw;
    try {
      raw = gm?.chunkManager?.getMinimapMarkers?.() ?? gm?.minimap?.getMinimapMarkers?.() ?? gm?.mapData?.minimapMarkers ?? [];
    } catch {
      raw = [];
    }
    if (!Array.isArray(raw) || !raw.length) {
      this.minimapMarkers = [];
      return;
    }
    if (!this._mmDumped) {
      this._mmDumped = true;
      const sample = raw[0];
      this.sendDiag(`MINIMAPMARKER keys=[${Object.keys(sample ?? {}).join(",")}] sample=${JSON.stringify(sample).slice(0, 300)}`);
    }
    const currentFloor = gm?.minimap?.currentFloor ?? gm?.currentFloor ?? 0;
    this.minimapMarkers = raw.filter((m) => m && typeof m.x === "number" && typeof m.z === "number").filter((m) => m.floor === void 0 || m.floor === null || m.floor === currentFloor).map((m) => ({
      x: m.x,
      z: m.z,
      floor: m.floor ?? 0,
      // icon is the image-key the game uses (loaded via its icon registry)
      icon: (m.icon ?? m.type ?? m.markerType ?? "") + "",
      size: typeof m.size === "number" ? m.size : 16,
      // label: not drawn by game; we show in tooltip on hover
      label: (m.label ?? m.name ?? m.title ?? m.tooltip ?? m.icon ?? "") + "",
      color: this.minimapMarkerColor(m)
    }));
  }
  minimapMarkerColor(m) {
    if (m.color) return m.color;
    const t = (m.type ?? m.markerType ?? m.icon ?? "") + "";
    if (/bank/i.test(t)) return "#f1c40f";
    if (/shop|store/i.test(t)) return "#e67e22";
    if (/spawn|boss/i.test(t)) return "#e74c3c";
    if (/quest/i.test(t)) return "#9b59b6";
    if (/dungeon|cave/i.test(t)) return "#7f8c8d";
    return "#ffd24a";
  }
  // ── Persistence (core plugin.data → IndexedDB, per user) ──────────────────────
  // plugin.data is a reactive object the core PluginDataManager auto-persists
  // (debounced) to IndexedDB keyed by the logged-in user. Shape:
  //   this.data.maps[mapId] = { obj: ObjRecord[], npc: { defId: {name, pts[]} } }
  //   this.data.filters     = { disabledCats, disabledNames, show*, ... }
  ensureDataShape() {
    if (!this.data.maps || typeof this.data.maps !== "object") this.data.maps = {};
    if (!this.data.filters || typeof this.data.filters !== "object") this.data.filters = {};
  }
  /** Merge ObjRecord[] into objectStore (union by tile+def key — never removes). */
  mergeObjRecords(arr) {
    for (const o of arr ?? []) {
      if (!o) continue;
      const key = `${o.x},${o.z},${o.floor},${o.defId}`;
      if (!this.objectStore.has(key)) {
        this.objectStore.set(key, { defId: o.defId, category: o.category, name: o.name, x: o.x, z: o.z, floor: o.floor, depleted: false, assetId: o.assetId ?? "" });
      }
    }
  }
  /** Merge persisted NPC records ({defId:{name,pts}}) into npcStore (union of sighting tiles). */
  mergeNpcRecords(npc) {
    for (const defIdStr of Object.keys(npc ?? {})) {
      const defId = Number(defIdStr);
      const entry = npc[defIdStr];
      let m = this.npcStore.get(defId);
      if (!m) {
        m = /* @__PURE__ */ new Map();
        this.npcStore.set(defId, m);
      }
      for (const p of entry.pts ?? []) {
        const [x, z, level, floor, seen] = p;
        const k = `${x},${z}`;
        if (!m.has(k)) m.set(k, { defId, name: entry.name, x, z, level: level < 0 ? void 0 : level, floor: floor ?? void 0, seen: seen || 0 });
      }
      if (!this.npcNameDef.has(entry.name)) this.npcNameDef.set(entry.name, defId);
    }
  }
  loadStores() {
    try {
      this.ensureDataShape();
      this.migrateLegacyLocalStorage();
      const mapData = this.data.maps[this.mapId];
      if (mapData) {
        this.mergeObjRecords(mapData.obj);
        this.mergeNpcRecords(mapData.npc);
      }
      try {
        const raw = localStorage.getItem(`eq_wm_store:${this.mapId}`);
        if (raw) {
          const bk = JSON.parse(raw);
          this.mergeObjRecords(bk.obj);
          this.mergeNpcRecords(bk.npc);
        }
      } catch {
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
      this.ensureDataShape();
      const objArr = [...this.objectStore.values()].map((o) => ({ defId: o.defId, category: o.category, name: o.name, x: o.x, z: o.z, floor: o.floor, assetId: o.assetId }));
      const npcObj = {};
      for (const [defId, m] of this.npcStore) {
        const first = m.values().next().value;
        npcObj[defId] = { name: first?.name ?? `NPC #${defId}`, pts: [...m.values()].map((s) => [s.x, s.z, s.level ?? -1, s.floor ?? 0, s.seen ?? 0]) };
      }
      this.data.maps[this.mapId] = { obj: objArr, npc: npcObj };
      try {
        localStorage.setItem(`eq_wm_store:${this.mapId}`, JSON.stringify({ obj: objArr, npc: npcObj }));
      } catch {
      }
    } catch (e) {
      this.warn("persistStores failed: " + (e?.message || e));
    }
  }
  loadFilterState() {
    try {
      this.ensureDataShape();
      const f = this.data.filters;
      if (!f || !Object.keys(f).length) return;
      this.disabledCats = new Set(f.disabledCats ?? []);
      this.disabledNames = new Set(f.disabledNames ?? []);
      this.showLiveNpcs = f.showLiveNpcs ?? true;
      this.showNpcSightings = f.showNpcSightings ?? true;
      this.showPlayers = f.showPlayers ?? true;
      this.iconsEnabled = f.iconsEnabled ?? true;
      this.labelsEnabled = f.labelsEnabled ?? true;
      this.showMinimapMarkers = f.showMinimapMarkers ?? true;
      this.mapMode = this.isMobile || f.mapMode === "overlay" ? "overlay" : "window";
    } catch {
    }
  }
  saveFilterState() {
    try {
      this.ensureDataShape();
      this.data.filters = {
        disabledCats: [...this.disabledCats],
        disabledNames: [...this.disabledNames],
        showLiveNpcs: this.showLiveNpcs,
        showNpcSightings: this.showNpcSightings,
        showPlayers: this.showPlayers,
        iconsEnabled: this.iconsEnabled,
        labelsEnabled: this.labelsEnabled,
        showMinimapMarkers: this.showMinimapMarkers,
        mapMode: this.mapMode
      };
    } catch {
    }
  }
  migrateLegacyLocalStorage() {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    try {
      const objRaw = localStorage.getItem(`evilitemap:obj:${this.mapId}`);
      const npcRaw = localStorage.getItem(`evilitemap:npc:${this.mapId}`);
      if ((objRaw || npcRaw) && !this.data.maps[this.mapId]) {
        this.data.maps[this.mapId] = {
          obj: objRaw ? JSON.parse(objRaw) : [],
          npc: npcRaw ? JSON.parse(npcRaw) : {}
        };
      }
      const filtRaw = localStorage.getItem("evilitemap:filters");
      if (filtRaw && !Object.keys(this.data.filters).length) {
        this.data.filters = JSON.parse(filtRaw);
      }
      for (const k of ["obj", "npc"]) localStorage.removeItem(`evilitemap:${k}:${this.mapId}`);
      localStorage.removeItem("evilitemap:filters");
    } catch {
    }
  }
  bakeStoneTexture() {
    if (this.stoneTexBaked) return Promise.resolve(this.stoneTexBaked);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth, h = img.naturalHeight;
          const c = document.createElement("canvas");
          c.width = h;
          c.height = w;
          const cx = c.getContext("2d");
          cx.translate(c.width / 2, c.height / 2);
          cx.rotate(Math.PI / 2);
          cx.drawImage(img, -w / 2, -h / 2);
          this.stoneTexBaked = c.toDataURL("image/png");
        } catch {
          this.stoneTexBaked = null;
        }
        resolve(this.stoneTexBaked);
      };
      img.onerror = () => resolve(null);
      img.src = "https://evilquest.net/ui/stone-dark.png";
    });
  }
  installKeyHandler() {
    if (this.keyHandlerInstalled) return;
    this.keyHandlerInstalled = true;
    window.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "m" || e.key === "M") this.openMapWindow();
      if (e.ctrlKey && e.shiftKey && (e.key === "B" || e.key === "b") && import.meta?.env?.DEV) {
        e.preventDefault();
        void this.renderAllIcons();
      }
      if (e.ctrlKey && e.shiftKey && (e.key === "E" || e.key === "e")) {
        e.preventDefault();
        void this.exportMap();
      }
    }, { capture: true });
  }
  getTilesForFloor(cm, cx, cz, radius, floor) {
    if (floor === 0 || typeof cm.floorLayerData?.get !== "function") {
      return cm.getTilesForMinimap(cx, cz, radius);
    }
    const size = radius * 2;
    const startX = Math.floor(cx) - radius;
    const startZ = Math.floor(cz) - radius;
    const buf = {
      tiles: new Uint8Array(size * size),
      walls: new Uint8Array(size * size),
      voidTiles: new Uint8Array(size * size),
      roofs: new Uint8Array(size * size),
      textured: new Uint8Array(size * size),
      overrideColors: new Uint8Array(size * size * 3),
      hasOverride: new Uint8Array(size * size),
      size,
      startX,
      startZ
    };
    buf.voidTiles.fill(1);
    const layer = cm.floorLayerData.get(floor);
    if (!layer) return buf;
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const worldX = startX + x;
        const worldZ = startZ + z;
        if (worldX < 0 || worldX >= cm.mapWidth || worldZ < 0 || worldZ >= cm.mapHeight) continue;
        const idx = worldZ * cm.mapWidth + worldX;
        const localIdx = z * size + x;
        const hasTile = layer.tiles?.has(idx);
        const hasFloor = layer.floors?.has(idx);
        const hasWall = layer.walls?.has(idx);
        const hasRoof = layer.roofs?.has(idx);
        const hasStair = layer.stairs?.has(idx);
        if (hasTile || hasFloor || hasWall || hasRoof || hasStair) {
          buf.voidTiles[localIdx] = 0;
          buf.tiles[localIdx] = layer.tiles?.get(idx) ?? layer.floors?.get(idx) ?? 0;
          buf.walls[localIdx] = layer.walls?.get(idx) ?? 0;
          if (hasRoof) buf.roofs[localIdx] = 1;
          if (hasFloor || hasStair) buf.textured[localIdx] = 1;
        }
      }
    }
    return buf;
  }
  loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = src;
    });
  }
  /** Seed a freshly-(re)created worldCanvas with previously-explored terrain so the live
   *  map survives reloads/logins instead of resetting to the chunks loaded right now.
   *  Two sources, layered cheapest-first (later overwrites earlier):
   *    1. shipped prebake (PluginAssetCache 'world-map-terrain') → packaged users get a
   *       full map immediately (read-only in shipped builds).
   *    2. the user's own localStorage accumulation ('eq_wm_offline') → their latest explore.
   *  The composite is drawn with destination-over so the live current-region paint (opaque,
   *  drawn synchronously by rebuildWorldCanvas right after creation) always wins — the seed
   *  only fills the gaps. Walls are filled for cells untouched this session; the live region
   *  self-corrects on the next rebuild. Fully async + token-guarded against floor/size change. */
  async seedWorldFromCaches(mapW, mapH, floor) {
    const token = ++this.worldSeedToken;
    const id = this.mapId || "world";
    const matches = (b) => b && b.id === id && b.floor === floor && b.W === mapW && b.H === mapH;
    const layers = [];
    try {
      const baked = await this.terrainCacheStore.load();
      const pre = baked[`${id}:${floor}`];
      if (pre) {
        const b = JSON.parse(pre);
        if (matches(b)) layers.push(b);
      }
    } catch {
    }
    if (token !== this.worldSeedToken) return;
    const ls = this.loadOfflineBundle();
    if (matches(ls)) layers.push(ls);
    if (!layers.length) return;
    const tmp = document.createElement("canvas");
    tmp.width = mapW;
    tmp.height = mapH;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    let drewTerrain = false;
    for (const b of layers) {
      if (typeof b.t === "string") {
        try {
          const img = await this.loadImage(b.t);
          if (token !== this.worldSeedToken) return;
          tctx.drawImage(img, 0, 0);
          drewTerrain = true;
        } catch {
        }
      }
      if (Array.isArray(b.wl)) {
        const ww = this.worldWalls;
        for (let i = 0; i + 2 < b.wl.length; i += 3) {
          const x = b.wl[i] | 0, z = b.wl[i + 1] | 0, wf = b.wl[i + 2];
          if (x < 0 || x >= mapW || z < 0 || z >= mapH) continue;
          const k = z * mapW + x;
          if (!ww[k]) ww[k] = wf;
        }
      }
    }
    if (!drewTerrain || token !== this.worldSeedToken || !this.worldCtx) return;
    const ctx = this.worldCtx;
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
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
      this.worldWalls = new Uint8Array(mapW * mapH);
      this.worldCtx = this.worldCanvas.getContext("2d", { willReadFrequently: true });
      this.lastPaintedSize = -1;
      void this.seedWorldFromCaches(mapW, mapH, this.currentFloor);
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
      buf = this.getTilesForFloor(cm, cx, cz, radius, this.currentFloor);
    } catch {
      return this.lastPaintedSize >= 0;
    }
    if (!buf) return false;
    const { tiles, walls, roofs, textured, voidTiles, overrideColors, hasOverride, size, startX, startZ } = buf;
    const T = _WorldMapPlugin.T, TC = _WorldMapPlugin.TYPE_COLOR, TEX = _WorldMapPlugin.TEXTURED_COLOR, ROOF = _WorldMapPlugin.ROOF_COLOR;
    const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : v | 0;
    const ctx = this.worldCtx;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const W = size + 1;
    const heights = new Float32Array(W * W);
    if (typeof cm.getVertexHeight === "function") {
      for (let Z = 0; Z < W; Z++) {
        for (let Q = 0; Q < W; Q++) {
          heights[Z * W + Q] = cm.getVertexHeight(startX + Q, startZ + Z);
        }
      }
    }
    for (let f = 0; f < size; f++) {
      for (let m = 0; m < size; m++) {
        const b = f * size + m;
        if (voidTiles[b]) continue;
        const type = tiles[b], wallRaw = walls[b];
        if (type === T.WALL || (wallRaw & 5) === 5 || (wallRaw & 10) === 10) {
          let vt = 0, kt = 0;
          for (let nt = -1; nt <= 1; nt++) {
            for (let st = -1; st <= 1; st++) {
              const St = m + st, Bt = f + nt;
              if (St < 0 || St >= size || Bt < 0 || Bt >= size) continue;
              const gt = Bt * size + St;
              const Yt = tiles[gt], Ft = walls[gt];
              if (Yt !== T.WALL && (Ft & 5) !== 5 && (Ft & 10) !== 10) {
                vt += heights[Bt * W + St];
                kt++;
              }
            }
          }
          const Mt = kt > 0 ? vt / kt : 0;
          heights[f * W + m] = Mt;
          heights[f * W + m + 1] = Mt;
          heights[(f + 1) * W + m] = Mt;
          heights[(f + 1) * W + m + 1] = Mt;
        }
      }
    }
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
        let col = TC[type] ?? TC[T.GRASS];
        if (hasOverride[b] === 1) {
          const e = b * 3;
          col = [overrideColors[e], overrideColors[e + 1], overrideColors[e + 2]];
        }
        if (isTex) col = TEX;
        if (isRoof) col = ROOF;
        let r = col[0], g = col[1], bl = col[2];
        if (isWall) {
          r = clamp(r * 0.55);
          g = clamp(g * 0.55);
          bl = clamp(bl * 0.55);
        }
        if (type === T.WATER) {
          const waterNoise = ((worldX * 3 * 73856093 ^ worldZ * 7 * 19349663) & 255) / 255 * 6 - 3;
          r = clamp(r + waterNoise * 0.5);
          g = clamp(g + waterNoise * 0.3);
          bl = clamp(bl + waterNoise * 0.2);
        } else if (type !== T.MUD) {
          const noise = ((worldX * 73856093 ^ worldZ * 19349663) & 255) / 255 * 6 - 3;
          const ht = heights[f * W + m];
          const pt = heights[f * W + m + 1];
          const Ot = heights[(f + 1) * W + m];
          const ut = pt - ht;
          const vt = Ot - ht;
          const fi = this.currentFloor === 0 ? (-ut * 0.7 - vt * 0.7) * 30 : 0;
          r = clamp(r + noise + fi);
          g = clamp(g + noise + fi);
          bl = clamp(bl + noise + fi);
        }
        const o = b * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = bl;
        data[o + 3] = 255;
      }
    }
    for (let f = 0; f < size; f++) {
      for (let m = 0; m < size; m++) {
        const b = f * size + m;
        const worldX = startX + m, worldZ = startZ + f;
        if (worldX < 0 || worldX >= mapW || worldZ < 0 || worldZ >= mapH) continue;
        if (voidTiles[b]) continue;
        const wf = walls[b];
        const type = tiles[b];
        if (!wf || type === T.WALL || (wf & 5) === 5 || (wf & 10) === 10) {
          this.worldWalls[worldZ * mapW + worldX] = 0;
        } else {
          this.worldWalls[worldZ * mapW + worldX] = wf;
        }
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
  // ── Map export (for the wiki: standalone interactive HTML the Hub can host + iframe) ─
  /**
   * Export the explored map to a single self-contained HTML that MIRRORS the live map:
   * the viewer re-renders terrain + icons at any zoom (sharp, not a baked image), with
   * the same tile-grouping, icon sizing, category filters, POIs and search. Exports the
   * DATA (terrain image + marker positions + icon images), not a flat PNG. Ctrl+Shift+E.
   */
  /** Collapse persisted NPC sightings into one "last-known" marker per spawn. For each
   *  defId we cluster its sighting tiles by proximity (a wanderer's trail → one marker;
   *  two separate spawns of the same def → two) and emit the most-recently-seen tile of
   *  each cluster. Respects the NPC category/name filters. Used for the Stored/Live NPC
   *  modes in the window + offline view, where we have no live entities to draw. */
  buildNpcSightings(floor, iconIdxOf) {
    const MERGE2 = 25 * 25;
    const out = [];
    const nameOff = (n) => this.disabledCats.has(_WorldMapPlugin.NPC_CAT) || this.disabledNames.has(`${_WorldMapPlugin.NPC_CAT}:${n}`);
    const placed = /* @__PURE__ */ new Map();
    const place = (defId, x, z, n, l) => {
      out.push({ x, z, n: this.prettify(n), l, i: iconIdxOf(defId) });
      let arr = placed.get(defId);
      if (!arr) {
        arr = [];
        placed.set(defId, arr);
      }
      arr.push({ x, z });
    };
    const covered = (defId, x, z) => {
      const arr = placed.get(defId);
      if (!arr) return false;
      for (const p of arr) {
        const dx = p.x - x, dz = p.z - z;
        if (dx * dx + dz * dz <= MERGE2) return true;
      }
      return false;
    };
    for (const n of this.liveNpcs) {
      if ((n.floor ?? 0) === floor && !nameOff(n.name)) {
        let arr = placed.get(n.defId);
        if (!arr) {
          arr = [];
          placed.set(n.defId, arr);
        }
        arr.push({ x: n.x, z: n.z });
      }
    }
    for (const s of this.sessionNpcs.values()) {
      if ((s.floor ?? 0) !== floor || nameOff(s.name)) continue;
      place(s.defId, s.x, s.z, s.name, s.level ?? 0);
    }
    for (const [defId, m] of this.npcStore) {
      const name = m.values().next().value?.name ?? `NPC #${defId}`;
      if (nameOff(name)) continue;
      const pts = [...m.values()].filter((s) => (s.floor ?? 0) === floor).sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0));
      for (const s of pts) {
        if (!covered(defId, s.x, s.z)) {
          place(defId, s.x, s.z, name, s.level ?? 0);
        }
      }
    }
    return out;
  }
  /** Gather a full, self-contained snapshot of the explored map (terrain PNG + deduped
   *  icons + per-tile markers + categories + POIs + the player position). Used by both
   *  the HTML export and the detached map window. Returns null if the map isn't ready. */
  buildMapSnapshot() {
    const cm = this.getChunkManager();
    if (!cm || !this.rebuildWorldCanvas(cm) || !this.worldCanvas) {
      const b = this.bestOfflineBundle();
      return b ? { ...b, p: null, npc: [], pl: [], dest: null, online: false } : null;
    }
    const W = this.worldW, H = this.worldH;
    let terrain = this.terrainUrl;
    if (!terrain) {
      terrain = this.worldCanvas.toDataURL("image/png");
      this.terrainUrl = terrain;
      this.terrainUrlSig = this.worldW + "x" + this.worldH + ":" + this.lastPaintedSize + ":" + this.currentFloor;
    }
    const iconIdx = /* @__PURE__ */ new Map();
    const icons = [];
    const idxOf = (im) => {
      if (!im || !im.complete || !im.naturalWidth || !im.src.startsWith("data:")) return -1;
      let i = iconIdx.get(im.src);
      if (i === void 0) {
        i = icons.length;
        iconIdx.set(im.src, i);
        icons.push(im.src);
      }
      return i;
    };
    const groups = /* @__PURE__ */ new Map();
    const allObjects = [...this.objectStore.values(), ...this.liveEphemeral];
    for (const o of allObjects) {
      if (o.floor !== void 0 && o.floor !== this.currentFloor) continue;
      const k = `${o.x},${o.z}`;
      let arr = groups.get(k);
      if (!arr) {
        arr = [];
        groups.set(k, arr);
      }
      arr.push(o);
    }
    const catMap = /* @__PURE__ */ new Map();
    const objects = [];
    for (const group of groups.values()) {
      let rep = group[0];
      for (const g of group) {
        if (this.getObjectIcon(g)) rep = g;
      }
      const o = rep;
      if (!catMap.has(o.category)) catMap.set(o.category, { c: this.catColor(o.category), s: this.catShape(o.category) });
      objects.push({ x: o.x, z: o.z, i: idxOf(this.getObjectIcon(o)), c: o.category, n: this.prettify(o.name), k: group.length, d: o.depleted ? 1 : 0 });
    }
    const cats = [...catMap.entries()].map(([n, v]) => ({ n, c: v.c, s: v.s })).sort((a, b) => a.n.localeCompare(b.n));
    const mmIdx = /* @__PURE__ */ new Map();
    const mmIcons = [];
    const toDataUrl = (im) => {
      try {
        const c = document.createElement("canvas");
        c.width = im.naturalWidth;
        c.height = im.naturalHeight;
        c.getContext("2d").drawImage(im, 0, 0);
        return c.toDataURL("image/png");
      } catch {
        return null;
      }
    };
    const pois = [];
    for (const m of this.minimapMarkers) {
      let mi = -1;
      const im = this.getMmIcon(m.icon);
      if (im && im.complete && im.naturalWidth) {
        const du = toDataUrl(im);
        if (du) {
          let i = mmIdx.get(du);
          if (i === void 0) {
            i = mmIcons.length;
            mmIdx.set(du, i);
            mmIcons.push(du);
          }
          mi = i;
        }
      }
      pois.push({ x: m.x, z: m.z, n: (m.label || m.icon).replace(/\.(png|webp)$/i, "").replace(/_/g, " "), m: mi, s: Math.max(8, Math.min(32, m.size || 16)) });
    }
    const npc = this.liveNpcs.filter((n) => (n.floor ?? 0) === this.currentFloor).map((n) => ({ x: n.x, z: n.z, n: this.prettify(n.name), l: n.level ?? 0, i: idxOf(this.getNpcIcon(n.defId)) }));
    const pl = this.players.map((p) => ({ x: p.x, z: p.z, n: p.name }));
    const ns = this.buildNpcSightings(this.currentFloor, (d) => idxOf(this.getNpcIcon(d)));
    const wl = [];
    const ww = this.worldWalls;
    for (let z2 = 0; z2 < H; z2++) {
      const row = z2 * W;
      for (let x2 = 0; x2 < W; x2++) {
        const wf = ww[row + x2];
        if (wf) wl.push(x2, z2, wf);
      }
    }
    const player = this.getPlayerPos();
    const data = {
      id: this.mapId || "world",
      W,
      H,
      t: terrain,
      ic: icons,
      ob: objects,
      ct: cats,
      pi: pois,
      mm: mmIcons,
      floor: this.currentFloor,
      p: player ? { x: player.x, z: player.z } : null,
      npc,
      ns,
      pl,
      wl,
      online: !!player,
      dest: this.getMoveDest()
    };
    this.saveOfflineBundle(data);
    return data;
  }
  /** Cache the static map (terrain + walls + objects + icons) so the map window still
   *  works when logged out. Uses localStorage (evilquest.net origin, survives logout and
   *  cold launch) — plugin.data is per-user and PluginAssetCache is read-only in shipped
   *  builds, so neither is usable offline. Stripped of live entities; ~0.5-1MB for one map. */
  saveOfflineBundle(data) {
    try {
      const b = { id: data.id, W: data.W, H: data.H, t: data.t, ic: data.ic, ob: data.ob, ct: data.ct, pi: data.pi, mm: data.mm, wl: data.wl, ns: data.ns, floor: data.floor };
      const prev = this.loadOfflineBundle();
      const obc = (x) => Array.isArray(x?.ob) ? x.ob.length : 0;
      if (prev && prev.id === b.id && prev.floor === b.floor && (this.terrainScore(b) < this.terrainScore(prev) * 0.85 || obc(b) < obc(prev) * 0.85)) {
        return;
      }
      const json = JSON.stringify(b);
      localStorage.setItem("eq_wm_offline", json);
      const now = Date.now();
      if (now - this.lastTerrainBake > 3e4) {
        this.lastTerrainBake = now;
        this.terrainCacheStore.save(`${b.id}:${b.floor}`, json);
      }
    } catch {
    }
  }
  loadOfflineBundle() {
    try {
      const s = localStorage.getItem("eq_wm_offline");
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  }
  /** Rough "how much real map is in this bundle" score, for the save downgrade-guard.
   *  Terrain PNG byte length tracks painted (non-transparent) area; walls add weight. */
  terrainScore(b) {
    if (!b) return 0;
    return (typeof b.t === "string" ? b.t.length : 0) + (Array.isArray(b.wl) ? b.wl.length * 8 : 0);
  }
  /** Pull the shipped terrain prebake (build-committed full map) into memory once, so the
   *  offline snapshot can use it synchronously as a fallback. Safe to call repeatedly. */
  async loadShippedBundles() {
    if (this.shippedBundles) return;
    try {
      this.shippedBundles = await this.terrainCacheStore.load() || {};
    } catch {
      this.shippedBundles = {};
    }
  }
  /** A shipped prebake bundle (parsed) for a map+floor, or any one if no exact match. */
  shippedBundleFor(id, floor) {
    const m = this.shippedBundles;
    if (!m) return null;
    let raw = m[`${id}:${floor}`] ?? m[`${id || "kcmap"}:0`];
    if (!raw) {
      const k = Object.keys(m)[0];
      if (k) raw = m[k];
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  /** Best available offline bundle: the user's saved exploration, but with terrain/walls
   *  backfilled from the shipped prebake when the saved one is missing or blank/weak. This
   *  is what stops the "objects but no terrain/walls" offline view (corrupted bundle or a
   *  fresh install that never logged in). */
  bestOfflineBundle() {
    const ls = this.loadOfflineBundle();
    const pre = this.shippedBundleFor(ls?.id || this.mapId || "kcmap", ls?.floor ?? this.currentFloor ?? 0);
    if (!ls) return pre;
    if (!pre) return ls;
    const obc = (x) => Array.isArray(x?.ob) ? x.ob.length : 0;
    if (this.terrainScore(ls) < this.terrainScore(pre) * 0.85 || obc(ls) < obc(pre) * 0.85) return pre;
    return ls;
  }
  /** The live click-to-move destination (the vanilla minimap flag target), or null. */
  getMoveDest() {
    const mm = this.gm?.minimap;
    if (mm && mm.destX != null && mm.destZ != null) return { x: mm.destX, z: mm.destZ };
    return null;
  }
  async exportMap() {
    const data = this.buildMapSnapshot();
    if (!data) {
      this.warn("export: map data not loaded (log in / open the map first)");
      return;
    }
    this.downloadFile(`evilquest-map-${this.mapId || "world"}.html`, this.buildExportHtml(data));
    this.info(`export: done \u2014 ${data.ob.length} markers, ${data.ic.length} icons, ${data.pi.length} POIs.`);
  }
  /** Open the World Map in a separate, movable/resizable OS window (so the user can keep
   *  playing the game underneath). The window runs the same interactive viewer as the
   *  HTML export; the game renderer streams it live data (player position frequently, a
   *  full snapshot occasionally) over IPC. */
  /** Mobile (Capacitor WebView) has no detached OS window — the map is overlay-only there.
   *  Set by the mobile shell (window.EvilLiteMobile); also reflected in electron.process.platform. */
  get isMobile() {
    return !!window.EvilLiteMobile || window.electron?.process?.platform === "android" || window.electron?.process?.platform === "ios";
  }
  /** Entry point (sidebar icon / M-key): toggle the map — open in the user's mode, or close
   *  if it's already open (re-tap / press M again closes). */
  openMap() {
    if (this.viewerOpen()) {
      this.closeViewer();
      return;
    }
    if (this.isMobile || this.mapMode === "overlay") this.openOverlayHost();
    else this.openWindowHost();
  }
  /** Close whichever host is open. */
  closeViewer() {
    if (this.overlayEl) this.closeOverlayHost();
    if (this.mapWindowOpen) {
      const ipc = window.electron?.ipcRenderer;
      ipc?.send("map-window:close");
      this.mapWindowOpen = false;
    }
  }
  /** Back-compat alias (chat-link handoff, older call sites). */
  openMapWindow() {
    this.openMap();
  }
  /** Host A — detached OS window (IPC transport). */
  openWindowHost() {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc?.send) {
      this.warn("map window: IPC unavailable");
      return;
    }
    if (this.mapWindowOpen) {
      ipc.send("map-window:focus");
      return;
    }
    this.refreshData();
    const snap = this.buildMapSnapshot();
    if (!snap) {
      this.warn("map: data not ready (log in / move around first)");
      return;
    }
    ipc.send("map-window:open", this.buildMapWindowHtml(snap, "window"));
    this.mapWindowOpen = true;
    if (!this.mwCloseHooked) {
      this.mwCloseHooked = true;
      ipc.on?.("map-window:closed", () => {
        this.mapWindowOpen = false;
        if (!this.overlayEl) this.stopMapWindowUpdates();
      });
      ipc.on?.("map-window:input", (_e, msg) => this.handleMapWindowInput(msg));
    }
    this.startMapWindowUpdates();
    this.info("map opened (window).");
  }
  /** Host B — in-page overlay docked over the game, rendered in a SHADOW ROOT (not an iframe).
   *
   *  Why shadow DOM, not an iframe: the game's anti-bot input-ticket system listens for trusted
   *  pointerdowns on the game `window` (window.addEventListener('pointerdown',_,true)) and mints an
   *  input ticket the next command borrows. A click inside an iframe fires on the iframe's SEPARATE
   *  window, which the game never sees — so iframe click-to-move ships with inputSeq=0 and the server
   *  rejects it (the "slingshot"). A shadow root lives in the GAME's document: your real click is a
   *  trusted pointerdown the game DOES register, and our synchronous move (sendInput → __wmInlineSend
   *  → handleMapWindowInput, all in the click's call stack) rides that genuine ticket. Same CSS
   *  isolation as the iframe, but the click is real and in-context — nothing faked. */
  openOverlayHost() {
    if (this.overlayEl) return;
    this.refreshData();
    const snap = this.buildMapSnapshot();
    if (!snap) {
      this.warn("map: data not ready (log in / move around first)");
      return;
    }
    const full = this.buildMapWindowHtml(snap, "overlay");
    const css = (full.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1];
    const markup = (full.match(/<body>([\s\S]*?)<script>/) || [, ""])[1];
    const script = (full.match(/<script>([\s\S]*?)<\/script><\/body>/) || [, ""])[1];
    const el = document.createElement("div");
    el.id = "eq-wm-overlay";
    const m = this.isMobile;
    Object.assign(el.style, m ? { position: "fixed", inset: "0", zIndex: "2147483640", overflow: "hidden", background: "#101012" } : { position: "fixed", top: "40px", left: "40px", right: "40px", bottom: "40px", zIndex: "2147483640", boxShadow: "0 6px 28px rgba(0,0,0,.6)", border: "1px solid #333", borderRadius: "6px", overflow: "hidden", background: "#101012" });
    const root = el.attachShadow({ mode: "open" });
    const cssFixed = css.replace(/body\.side-open/g, "#wmbody.side-open");
    root.innerHTML = "<style>:host{display:block;background:#101012;color:#e8e8e8;font:13px/1.4 Inter,system-ui,sans-serif;overflow:hidden}#wmbody{height:100%;display:block}#app{height:100%!important}" + cssFixed + '</style><div id="wmbody">' + markup + "</div>";
    document.body.appendChild(el);
    this.overlayEl = el;
    this.overlayShadow = root;
    this.overlayFrame = null;
    window.__wmInlineSend = (msg) => this.handleMapWindowInput(msg);
    this.hookOverlayMessages();
    try {
      new Function("document", script)(this.makeShadowDocShim(root));
    } catch (e) {
      this.warn("overlay viewer failed: " + e);
    }
    this.postToOverlay({ full: snap, p: snap.p });
    this.startMapWindowUpdates();
    this.info("map opened (overlay).");
  }
  /** A minimal `document` shim that points element lookups at the overlay's shadow root while
   *  leaving element creation / global event registration on the real document. */
  makeShadowDocShim(root) {
    const real = document;
    return {
      getElementById: (id) => root.getElementById(id),
      querySelector: (s) => root.querySelector(s),
      querySelectorAll: (s) => root.querySelectorAll(s),
      createElement: (t) => real.createElement(t),
      createElementNS: (ns, t) => real.createElementNS(ns, t),
      createTextNode: (t) => real.createTextNode(t),
      // body → the #wmbody wrapper (a real element with classList); head → the shadow root
      // (so injected <style> stays scoped to the overlay, not leaked into the game).
      get body() {
        return root.getElementById("wmbody") || root;
      },
      get head() {
        return root;
      },
      addEventListener: (...a) => real.addEventListener(...a),
      removeEventListener: (...a) => real.removeEventListener(...a)
    };
  }
  /** Receive input (click-move / floor / mode / close) from the overlay viewer. */
  hookOverlayMessages() {
    if (this.overlayMsgHooked) return;
    this.overlayMsgHooked = true;
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (d && d.__wmInput) this.handleMapWindowInput(d.__wmInput);
    });
  }
  closeOverlayHost() {
    if (this.overlayEl) {
      try {
        this.overlayEl.remove();
      } catch {
      }
    }
    this.overlayEl = null;
    this.overlayFrame = null;
    this.overlayShadow = null;
    try {
      delete window.__wmInlineSend;
    } catch {
    }
    if (!this.mapWindowOpen) this.stopMapWindowUpdates();
  }
  postToOverlay(payload) {
    if (this.overlayShadow) {
      try {
        window.postMessage({ __wmUpdate: payload }, "*");
      } catch {
      }
      return;
    }
    try {
      this.overlayFrame?.contentWindow?.postMessage({ __wmUpdate: payload }, "*");
    } catch {
    }
  }
  /** Push a data payload to whichever host(s) are currently open. */
  pushToViewer(payload) {
    if (this.mapWindowOpen) {
      const ipc = window.electron?.ipcRenderer;
      ipc?.send("map-window:update", payload);
    }
    if (this.overlayShadow) this.postToOverlay(payload);
  }
  /** The ⇄ toggle: switch between window and overlay hosts, remembering the choice. */
  switchMode() {
    if (this.isMobile) return;
    const target = this.mapMode === "window" ? "overlay" : "window";
    if (this.mapMode === "window" && this.mapWindowOpen) {
      const ipc = window.electron?.ipcRenderer;
      ipc?.send("map-window:close");
      this.mapWindowOpen = false;
    }
    if (this.mapMode === "overlay") this.closeOverlayHost();
    this.mapMode = target;
    this.saveFilterState();
    if (target === "overlay") this.openOverlayHost();
    else this.openWindowHost();
  }
  /** Re-attach to a detached map window that survived a renderer reload (the game's 5-min
   *  AFK kick reloads client.html; the window lives in the main process and stays open).
   *  Without this the window sits frozen on its last frame until the user closes+reopens it.
   *  Asks the main process if the window exists and, if so, resumes streaming + reloads its
   *  content with a fresh snapshot. Best-effort + idempotent (guarded by mapWindowOpen). */
  async reattachMapWindow() {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc?.invoke || !ipc?.send || this.mapWindowOpen) return;
    let exists = false;
    try {
      exists = await ipc.invoke("map-window:exists");
    } catch {
      return;
    }
    if (!exists || this.mapWindowOpen) return;
    this.mapWindowOpen = true;
    if (!this.mwCloseHooked) {
      this.mwCloseHooked = true;
      ipc.on?.("map-window:closed", () => {
        this.mapWindowOpen = false;
        this.stopMapWindowUpdates();
      });
      ipc.on?.("map-window:input", (_e, msg) => this.handleMapWindowInput(msg));
    }
    try {
      this.refreshData();
    } catch {
    }
    const snap = this.buildMapSnapshot();
    if (snap) ipc.send("map-window:open", this.buildMapWindowHtml(snap));
    this.startMapWindowUpdates();
    this.info("map window re-attached after reload.");
  }
  /** Hand a click-to-move to the game — SYNCHRONOUSLY, from within the user's real click.
   *
   *  The slingshot was an anti-bot rejection, not a movement bug: the game stamps each command
   *  with an inputSeq from a ticket minted by a trusted browser pointerdown the game's own
   *  window-capture listener sees. A move with no ticket ships inputSeq=0 and the server discards
   *  it as an inputless (bot) command → snapback. So this MUST run in the same call stack as the
   *  real click (overlay shadow-DOM → sendInput → __wmInlineSend → here), inside the 350ms input
   *  ticket burst, so it borrows the genuine click's ticket. Any deferral (timers, queues) fires
   *  outside the burst → inputSeq=0 → rejected, which is why earlier attempts failed.
   *
   *  Only valid from the overlay: there the click is a real, in-renderer pointerdown the game
   *  registers. The popout window is a separate renderer the game never sees, so its clicks can't
   *  be authorized — it's view-only (faking that authorization would be defeating the anti-bot
   *  system, which we don't do). */
  dispatchMapMove(worldX, worldZ) {
    if (!this.overlayShadow) return;
    const gm = this.gm;
    gm?.minimap?.onClickMove?.(worldX, worldZ, worldX, worldZ);
  }
  /** Apply an action forwarded from the detached map window back to the live game. */
  handleMapWindowInput(msg) {
    if (!msg) return;
    if (msg.t === "move") {
      let worldX = msg.x, worldZ = msg.z;
      const player = this.getPlayerPos();
      if (player) {
        const dx = worldX - player.x, dz = worldZ - player.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const MAX_CLICK_DIST = 45;
        if (dist > MAX_CLICK_DIST) {
          const r = MAX_CLICK_DIST / dist;
          worldX = player.x + dx * r;
          worldZ = player.z + dz * r;
        }
      }
      this.dispatchMapMove(worldX, worldZ);
    } else if (msg.t === "floor") {
      const f = Math.max(0, Math.min(8, msg.f | 0));
      if (f !== this.currentFloor) {
        this.currentFloor = f;
        this.worldCanvas = null;
        this.refreshData();
        const snap = this.buildMapSnapshot();
        if (snap) this.pushToViewer({ full: snap, p: snap.p });
      }
    } else if (msg.t === "mode") {
      this.switchMode();
    } else if (msg.t === "close") {
      if (this.overlayEl) this.closeOverlayHost();
      else if (this.mapWindowOpen) {
        const ipc = window.electron?.ipcRenderer;
        ipc?.send("map-window:close");
      }
    } else if (msg.t === "chat") {
      const textToCopy = msg.text;
      const chatInput = document.getElementById("chat-input");
      if (chatInput) {
        const currentVal = chatInput.value.trim();
        chatInput.value = currentVal ? `${currentVal} ${textToCopy}` : textToCopy;
        chatInput.focus();
      } else {
        this.setStatus("Chat input not found.");
      }
      if (this.overlayEl) this.closeOverlayHost();
    }
  }
  viewerOpen() {
    return this.mapWindowOpen || !!this.overlayEl;
  }
  startMapWindowUpdates() {
    this.stopMapWindowUpdates();
    this.mapWindowTimer = setInterval(() => {
      if (!this.viewerOpen()) return;
      this.refreshData();
      const p = this.getPlayerPos();
      const npc = this.liveNpcs.filter((n) => (n.floor ?? 0) === this.currentFloor).map((n) => ({ x: n.x, z: n.z, n: this.prettify(n.name), l: n.level ?? 0 }));
      const pl = this.players.map((q) => ({ x: q.x, z: q.z, n: q.name }));
      this.pushToViewer({ p: p ? { x: p.x, z: p.z } : null, npc, pl, online: !!p, dest: this.getMoveDest() });
    }, 280);
    this.mapWindowFullTimer = setInterval(() => {
      if (!this.viewerOpen()) return;
      this.refreshData();
      const sig = this.objectStore.size + ":" + this.liveEphemeral.length + ":" + this.currentFloor;
      if (sig === this.lastFullSig) return;
      this.lastFullSig = sig;
      const snap = this.buildMapSnapshot();
      if (snap) this.pushToViewer({ full: snap, p: snap.p });
    }, 7e3);
    this.mapTerrainTimer = setInterval(() => {
      if (!this.viewerOpen()) return;
      this.refreshTerrainAsync();
    }, 5e3);
  }
  stopMapWindowUpdates() {
    if (this.mapWindowTimer) {
      clearInterval(this.mapWindowTimer);
      this.mapWindowTimer = null;
    }
    if (this.mapWindowFullTimer) {
      clearInterval(this.mapWindowFullTimer);
      this.mapWindowFullTimer = null;
    }
    if (this.mapTerrainTimer) {
      clearInterval(this.mapTerrainTimer);
      this.mapTerrainTimer = null;
    }
  }
  /** Re-encode the terrain PNG OFF the main thread (canvas.toBlob is async, unlike the blocking
   *  toDataURL) and stream it to the viewer when explored tiles have changed — so the map fills in
   *  as you walk without ever freezing the game's movement tick. */
  refreshTerrainAsync() {
    if (this.terrainEncoding) return;
    const cm = this.getChunkManager();
    if (!cm || !this.rebuildWorldCanvas(cm) || !this.worldCanvas) return;
    const sig = this.worldW + "x" + this.worldH + ":" + this.lastPaintedSize + ":" + this.currentFloor;
    if (sig === this.terrainUrlSig) return;
    this.terrainEncoding = true;
    try {
      this.worldCanvas.toBlob((blob) => {
        this.terrainEncoding = false;
        if (!blob) return;
        const fr = new FileReader();
        fr.onload = () => {
          this.terrainUrl = fr.result;
          this.terrainUrlSig = sig;
          this.pushToViewer({ terrain: this.terrainUrl });
        };
        fr.onerror = () => {
        };
        fr.readAsDataURL(blob);
      }, "image/png");
    } catch {
      this.terrainEncoding = false;
    }
  }
  /** A self-contained interactive viewer that re-renders the exported data exactly like
   *  the live World Map (terrain scaling, icon sizing, category filters, POIs, search).
   *  In `live` mode it also draws the player marker and accepts data updates over IPC
   *  (used by the detached map window). */
  buildExportHtml(data, live = false) {
    const json = JSON.stringify(data);
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EvilQuest World Map - ' + data.id + '</title><style>html,body{margin:0;height:100%;background:#111;color:#eee;font:13px/1.4 Inter,system-ui,sans-serif;overflow:hidden}#app{display:flex;height:100%}#side{width:220px;flex:none;background:#1b1b1b;border-right:1px solid #333;display:flex;flex-direction:column}#side h1{font-size:14px;margin:0;padding:10px 12px;border-bottom:1px solid #333}#q{margin:8px;padding:6px 8px;border:1px solid #444;border-radius:4px;background:#111;color:#fff}#layers{padding:6px 12px;border-bottom:1px solid #333}#layers label,#cats label{display:block;padding:3px 0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#cats{overflow:auto;flex:1;padding:6px 10px}#cats .cat{margin-bottom:1px}#cats .chead{display:flex;align-items:center;padding:3px 0}#cats .chead .cn{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}#cats .exp{cursor:pointer;padding:0 5px;color:#9aa;user-select:none}#cats .subs{padding-left:20px}#cats .sub{display:block;padding:2px 0;font-size:12px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}#cats .sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin:0 6px;vertical-align:middle}#cats .ci{width:20px;height:20px;object-fit:contain;vertical-align:middle;margin:0 5px;flex:none}#cats .sub .ci{width:16px;height:16px}#view{flex:1;position:relative;overflow:hidden;background:#0a0a0a;cursor:grab}#view.drag{cursor:grabbing}#c{position:absolute;inset:0}#tip{position:absolute;background:#000d;border:1px solid #444;border-radius:4px;padding:4px 7px;font-size:12px;pointer-events:none;display:none;max-width:240px}#hint{position:absolute;right:8px;bottom:8px;background:#000a;padding:4px 8px;border-radius:4px;font-size:11px;pointer-events:none}</style></head><body><div id="app"><div id="side"><h1>World Map - ' + data.id + '</h1><input id="q" placeholder="Search..."><div id="layers"><label><input type="checkbox" id="L_ic" checked> Model icons</label><label><input type="checkbox" id="L_poi" checked> Minimap markers</label><label><input type="checkbox" id="L_lab"> Labels</label></div><div id="cats"></div></div><div id="view"><canvas id="c"></canvas><div id="tip"></div><div id="hint">drag to pan - scroll to zoom</div></div></div><script>(function(){var D=' + json + ';var view=document.getElementById("view"),cv=document.getElementById("c"),ctx=cv.getContext("2d"),tip=document.getElementById("tip"),q=document.getElementById("q");var terrain=new Image();terrain.src=D.t;var ICONS=D.ic.map(function(s){var i=new Image();i.src=s;return i;});var MM=D.mm.map(function(s){var i=new Image();i.src=s;return i;});var ICONS_S=new Array(ICONS.length);function shadowed(idx){if(ICONS_S[idx])return ICONS_S[idx];var im=ICONS[idx];if(!im||!im.complete||!im.naturalWidth)return null;var pad=4;var c=document.createElement("canvas");c.width=im.naturalWidth+pad*2;c.height=im.naturalHeight+pad*2;var x=c.getContext("2d");x.shadowColor="rgba(0,0,0,.55)";x.shadowBlur=2;x.drawImage(im,pad,pad);ICONS_S[idx]=c;return c;}var TAX={},nameOn={};D.ob.forEach(function(o){if(!TAX[o.c])TAX[o.c]={};TAX[o.c][o.n]=(TAX[o.c][o.n]||0)+o.k;});Object.keys(TAX).forEach(function(c){Object.keys(TAX[c]).forEach(function(n){nameOn[c+"|"+n]=true;});});var showIcons=true,showPoi=true,showLab=false;var cx=D.W/2,cz=D.H/2,Z=4,W=0,Hh=0,hits=[];function resize(){var r=view.getBoundingClientRect();W=cv.width=Math.floor(r.width);Hh=cv.height=Math.floor(r.height);render();}function clamp(v,a,b){return Math.max(a,Math.min(v,b));}function render(){if(!W)return;hits=[];ctx.fillStyle="#0a0a0a";ctx.fillRect(0,0,W,Hh);var sl=cx-W/(2*Z),st=cz-Hh/(2*Z);if(terrain.complete&&terrain.naturalWidth){ctx.imageSmoothingEnabled=true;ctx.save();ctx.translate(-sl*Z,-st*Z);ctx.scale(Z,Z);ctx.drawImage(terrain,0,0);ctx.restore();}if(D.wl&&D.wl.length){ctx.fillStyle="rgb(220,216,200)";var wt=Math.max(1.5,Z*0.15);for(var wi=0;wi<D.wl.length;wi+=3){var wx=D.wl[wi],wz=D.wl[wi+1],wf=D.wl[wi+2];var wsx=(wx-sl)*Z,wsy=(wz-st)*Z;if(wsx<-Z||wsx>W+Z||wsy<-Z||wsy>Hh+Z)continue;if(wf&1)ctx.fillRect(wsx,wsy,Z,wt);if(wf&4)ctx.fillRect(wsx,wsy+Z-wt,Z,wt);if(wf&8)ctx.fillRect(wsx,wsy,wt,Z);if(wf&2)ctx.fillRect(wsx+Z-wt,wsy,wt,Z);}}if(showIcons){for(var j=0;j<D.ob.length;j++){var o=D.ob[j];if(nameOn[o.c+"|"+o.n]===false)continue;var sx=(o.x-sl)*Z,sy=(o.z-st)*Z;if(sx<-30||sx>W+30||sy<-30||sy>Hh+30)continue;var hr;var sc=o.i>=0?shadowed(o.i):null;if(sc){var iim=ICONS[o.i];var sz=clamp(Z*3,24,50);var k=sz/iim.naturalWidth,dw=sc.width*k,dh=sc.height*k;ctx.globalAlpha=o.d?0.45:1;ctx.drawImage(sc,sx-dw/2,sy-dh/2,dw,dh);ctx.globalAlpha=1;hr=sz/2;}else{var col=(D.ct.filter(function(c){return c.n==o.c;})[0]||{c:"#ffd24a"}).c;var br=clamp(Z*0.55,3,9);ctx.fillStyle=col;ctx.globalAlpha=o.d?0.4:1;ctx.beginPath();ctx.arc(sx,sy,br,0,6.28);ctx.fill();ctx.globalAlpha=1;hr=br;}if(o.k>1){ctx.fillStyle="#c0392b";ctx.beginPath();ctx.arc(sx+hr*0.8,sy-hr*0.8,6,0,6.28);ctx.fill();ctx.fillStyle="#fff";ctx.font="9px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(o.k>9?"9+":""+o.k,sx+hr*0.8,sy-hr*0.8);}hits.push({sx:sx,sy:sy,r:hr,n:o.n+(o.k>1?" +"+(o.k-1):""),s:o.c+" - "+o.x+","+o.z});if(showLab){ctx.fillStyle="#fff";ctx.font="11px sans-serif";ctx.textAlign="center";ctx.textBaseline="bottom";ctx.shadowColor="#000";ctx.shadowBlur=3;ctx.fillText(o.n,sx,sy-hr-2);ctx.shadowBlur=0;}}}if(showPoi){for(var p=0;p<D.pi.length;p++){var P=D.pi[p];var px=(P.x-sl)*Z,py=(P.z-st)*Z;if(px<-30||px>W+30||py<-30||py>Hh+30)continue;var u=P.s;ctx.save();ctx.globalAlpha=0.7;ctx.fillStyle="rgba(0,0,0,.68)";ctx.beginPath();ctx.arc(px,py,u*0.55,0,6.28);ctx.fill();ctx.restore();if(P.m>=0&&MM[P.m].complete&&MM[P.m].naturalWidth)ctx.drawImage(MM[P.m],px-u/2,py-u/2,u,u);hits.push({sx:px,sy:py,r:u/2,n:P.n,s:P.x+","+P.z});}}if(D.p){var ppx=(D.p.x-sl)*Z,ppy=(D.p.z-st)*Z;ctx.save();ctx.fillStyle="#19b9ff";ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.beginPath();ctx.arc(ppx,ppy,6,0,6.28);ctx.fill();ctx.stroke();ctx.restore();}}function fit(){var pad=10;Z=clamp(Math.min(W/(D.W+pad),Hh/(D.H+pad)),0.3,48);cx=D.W/2;cz=D.H/2;render();}var dragging=false,lx=0,ly=0,moved=false;view.addEventListener("mousedown",function(e){if(e.button!==0)return;dragging=true;moved=false;lx=e.clientX;ly=e.clientY;view.classList.add("drag");});window.addEventListener("mouseup",function(){dragging=false;view.classList.remove("drag");});view.addEventListener("mousemove",function(e){if(dragging){var dx=e.clientX-lx,dy=e.clientY-ly;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;cx-=dx/Z;cz-=dy/Z;lx=e.clientX;ly=e.clientY;render();tip.style.display="none";return;}var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,best=null,bd=1e9;for(var i=hits.length-1;i>=0;i--){var h=hits[i],d=(h.sx-mx)*(h.sx-mx)+(h.sy-my)*(h.sy-my);if(d<(h.r+4)*(h.r+4)&&d<bd){bd=d;best=h;}}if(best){tip.style.display="block";tip.style.left=(mx+14)+"px";tip.style.top=(my+10)+"px";tip.innerHTML="<b>"+best.n+"</b><br>"+best.s;}else tip.style.display="none";});view.addEventListener("wheel",function(e){e.preventDefault();var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;var wx=cx-W/(2*Z)+mx/Z,wz=cz-Hh/(2*Z)+my/Z;var f=e.deltaY<0?1.15:1/1.15;Z=clamp(Z*f,0.3,48);cx=wx+W/(2*Z)-mx/Z;cz=wz+Hh/(2*Z)-my/Z;render();},{passive:false});view.addEventListener("contextmenu",function(e){e.preventDefault();var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;var wx=cx-W/(2*Z)+mx/Z,wz=cz-Hh/(2*Z)+my/Z;var textToCopy="("+Math.round(wx)+","+Math.round(wz)+")";var best=null,bd=1e9;for(var i=hits.length-1;i>=0;i--){var h=hits[i],d=(h.sx-mx)*(h.sx-mx)+(h.sy-my)*(h.sy-my);if(d<(h.r+4)*(h.r+4)&&d<bd){bd=d;best=h;}}if(best){textToCopy+="["+best.n.replace(/\\s*\\+\\d+$/,"").trim()+"]";}var m=document.getElementById("eq-map-context-menu");if(m)m.remove();m=document.createElement("div");m.id="eq-map-context-menu";m.style.cssText="position:fixed;left:"+e.clientX+"px;top:"+e.clientY+"px;background:#473e32;border:1px solid #1a1612;border-top-color:#72624d;border-left-color:#72624d;z-index:10000;box-shadow:2px 2px 4px rgba(0,0,0,0.5);user-select:none;min-width:120px;font-family:sans-serif;";var hdr=document.createElement("div");hdr.style.cssText="background:#362e24;padding:4px 8px;border-bottom:1px solid #1a1612;color:#ffd24a;font-weight:bold;text-align:center;font-size:12px;cursor:default";hdr.textContent="Select an Option";m.appendChild(hdr);var itm=document.createElement("div");itm.style.cssText="padding:6px 10px;cursor:pointer;color:#fff;font-size:13px";itm.textContent="Share "+textToCopy;itm.onmouseenter=function(){itm.style.background="#5c5040";};itm.onmouseleave=function(){itm.style.background="transparent";};itm.onclick=function(ev){ev.stopPropagation();m.remove();if(typeof sendInput!=="undefined"){sendInput({t:"chat",text:textToCopy});}else if(window.electron&&window.electron.ipcRenderer){window.electron.ipcRenderer.send("map-window:input",{t:"chat",text:textToCopy});}};m.appendChild(itm);document.body.appendChild(m);var closeM=function(ev){var pth=(ev.composedPath&&ev.composedPath())||[];if(!m.contains(ev.target)&&pth.indexOf(m)<0){m.remove();window.removeEventListener("mousedown",closeM);}};setTimeout(function(){window.addEventListener("mousedown",closeM);},0);});function goTo(x,z){Z=Math.max(Z,16);cx=x+0.5;cz=z+0.5;render();}function buildTax(){var box=document.getElementById("cats");box.innerHTML="";var esc=function(t){var d=document.createElement("span");d.textContent=t;return d.innerHTML;};var catIcon={},nameIcon={};D.ob.forEach(function(o){if(o.i>=0){if(catIcon[o.c]===undefined)catIcon[o.c]=o.i;if(nameIcon[o.c+"|"+o.n]===undefined)nameIcon[o.c+"|"+o.n]=o.i;}});var swatch=function(i,col){return i!==undefined?"<img class=ci src=\\""+D.ic[i]+"\\">":"<span class=sw style=background:"+col+"></span>";};Object.keys(TAX).sort().forEach(function(c){var col=(D.ct.filter(function(x){return x.n==c;})[0]||{c:"#ffd24a"}).c;var names=Object.keys(TAX[c]).sort();var tot=0;names.forEach(function(n){tot+=TAX[c][n];});var g=document.createElement("div");g.className="cat";var head=document.createElement("div");head.className="chead";head.innerHTML="<input type=checkbox class=cc checked>"+swatch(catIcon[c],col)+"<span class=cn>"+esc(c)+" ("+tot+")</span><span class=exp>\\u25b8</span>";var subs=document.createElement("div");subs.className="subs";subs.style.display="none";names.forEach(function(n){var l=document.createElement("label");l.className="sub";l.innerHTML="<input type=checkbox class=nc checked>"+swatch(nameIcon[c+"|"+n],col)+esc(n)+" ("+TAX[c][n]+")";var nb=l.querySelector("input");nb.onchange=function(){nameOn[c+"|"+n]=nb.checked;var any=names.some(function(x){return nameOn[c+"|"+x]!==false;});head.querySelector(".cc").checked=any;render();};subs.appendChild(l);});var cc=head.querySelector(".cc");cc.onchange=function(){var on=cc.checked;names.forEach(function(n){nameOn[c+"|"+n]=on;});subs.querySelectorAll(".nc").forEach(function(x){x.checked=on;});render();};head.querySelector(".exp").onclick=function(){var open=subs.style.display==="none";subs.style.display=open?"block":"none";this.textContent=open?"\\u25be":"\\u25b8";};g.appendChild(head);g.appendChild(subs);box.appendChild(g);});}document.getElementById("L_ic").onchange=function(e){showIcons=e.target.checked;render();};document.getElementById("L_poi").onchange=function(e){showPoi=e.target.checked;render();};document.getElementById("L_lab").onchange=function(e){showLab=e.target.checked;render();};q.oninput=function(){var s=q.value.trim().toLowerCase();if(!s)return;var best=null,bd=1e9;function consider(x,z,n){if(n.toLowerCase().indexOf(s)<0)return;var d=(x-cx)*(x-cx)+(z-cz)*(z-cz);if(d<bd){bd=d;best=[x,z];}}D.ob.forEach(function(o){consider(o.x,o.z,o.n+" "+o.c);});D.pi.forEach(function(P){consider(P.x,P.z,P.n);});if(best)goTo(best[0],best[1]);};buildTax();window.addEventListener("resize",resize);var ld=0;[terrain].concat(ICONS,MM).forEach(function(im){im.addEventListener("load",function(){if(++ld%40==0)render();});});setTimeout(render,400);setTimeout(render,1500);' + (live ? 'var follow=true;if(window.electron&&window.electron.ipcRenderer&&window.electron.ipcRenderer.on){window.electron.ipcRenderer.on("map-window:update",function(e,u){if(!u)return;if(u.full){var nd=u.full;D.t=nd.t;terrain=new Image();terrain.src=D.t;D.ic=nd.ic;ICONS=D.ic.map(function(s){var i=new Image();i.src=s;return i;});D.ob=nd.ob;D.ct=nd.ct;D.pi=nd.pi;D.mm=nd.mm;MM=D.mm.map(function(s){var i=new Image();i.src=s;return i;});D.W=nd.W;D.H=nd.H;TAX={};D.ob.forEach(function(o){if(!TAX[o.c])TAX[o.c]={};TAX[o.c][o.n]=(TAX[o.c][o.n]||0)+o.k;});Object.keys(TAX).forEach(function(c){Object.keys(TAX[c]).forEach(function(n){if(nameOn[c+"|"+n]===undefined)nameOn[c+"|"+n]=true;});});buildTax();}if(u.p!==undefined){D.p=u.p;if(follow&&D.p){cx=D.p.x+0.5;cz=D.p.z+0.5;}}render();});}var fb=document.createElement("label");fb.style.cssText="display:block;padding:3px 0;cursor:pointer";fb.innerHTML="<input type=checkbox id=L_follow checked> Follow player";document.getElementById("layers").appendChild(fb);document.getElementById("L_follow").onchange=function(e){follow=e.target.checked;if(follow&&D.p){cx=D.p.x+0.5;cz=D.p.z+0.5;render();}};view.addEventListener("mousedown",function(){var fc=document.getElementById("L_follow");if(fc&&fc.checked){fc.checked=false;follow=false;}});' : "") + "resize();fit();})();<\/script></body></html>";
  }
  /** The detached map window's viewer. Renders the live snapshot locally (terrain, icons,
   *  POIs, NPCs, players, player marker) with the in-game overlay's controls (search, floor
   *  stepper, follow, filters). When the game is live it receives streamed data updates and
   *  forwards click-to-move / floor changes back over IPC; offline it stays a static
   *  snapshot with Follow greyed out. */
  buildMapWindowHtml(data, host = "window") {
    const json = JSON.stringify(data);
    const bg = this.stoneTexBaked || "https://evilquest.net/ui/stone-dark.png";
    return `<!doctype html><html><head><meta charset="utf-8"><title>EvilLite \u2014 World Map</title><style>
html,body{margin:0;height:100%;background:#101012;color:#e8e8e8;font:13px/1.4 Inter,system-ui,sans-serif;overflow:hidden;user-select:none}
#app{display:flex;flex-direction:column;height:100vh}
#hdr{display:flex;align-items:center;gap:8px;padding:6px 8px;background:linear-gradient(rgba(15,12,10,.35),rgba(15,12,10,.5)),url("${bg}");border-bottom:1px solid #333}
#hdr h1{font-size:14px;margin:0 4px 0 2px;white-space:nowrap}
#q{flex:1;max-width:240px;padding:5px 8px;border:1px solid #555;border-radius:4px;background:#111;color:#fff;font-size:13px}
.fl{display:flex;align-items:center;gap:1px;background:rgba(0,0,0,.28);border-radius:6px;padding:2px 3px}
.fl button{padding:2px 7px;background:transparent;border:none;border-radius:4px;color:#cfd6dc;font-size:12px;cursor:pointer}
.fl button:hover{background:#3a4046}.fl span{font-weight:600;min-width:50px;text-align:center;font-size:12px}
.btn{padding:5px 12px;border:none;border-radius:4px;color:#fff;font-size:13px;cursor:pointer;white-space:nowrap}
#follow{background:#27ae60}#follow.off{background:#3a3f44}#follow.dis{opacity:.45;cursor:default}
#close{background:transparent;color:#ccc;font-size:16px;padding:4px 9px;line-height:1}#close:hover{background:#e74c3c;color:#fff}
#modeToggle{background:#2f6db0;color:#fff;font-weight:600;border:1px solid #5a9fe0}#modeToggle:hover{background:#3f86d6}
#body{flex:1;display:flex;min-height:0}
#side{width:210px;flex:none;overflow:auto;background:#161616;border-right:1px solid #333;padding:6px 10px}
#layers{padding-bottom:6px;border-bottom:1px solid #333;margin-bottom:6px}
#layers label,#cats label{display:block;padding:3px 0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cats .cat{margin-bottom:1px}#cats .chead{display:flex;align-items:center;padding:3px 0}
#cats .chead .cn{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cats .exp{cursor:pointer;padding:0 5px;color:#9aa}#cats .subs{padding-left:18px}
#cats .sub{display:block;padding:2px 0;font-size:12px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
#cats .sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin:0 6px;vertical-align:middle}
#cats .ci{width:20px;height:20px;object-fit:contain;vertical-align:middle;margin:0 5px}#cats .sub .ci{width:16px;height:16px}
#view{flex:1;position:relative;overflow:hidden;background:linear-gradient(rgba(8,7,6,.55),rgba(8,7,6,.7)),url("${bg}");cursor:grab}
#view.drag{cursor:grabbing}#c{position:absolute;inset:0}
#tip{position:absolute;background:#000d;border:1px solid #444;border-radius:4px;padding:4px 7px;font-size:12px;pointer-events:none;display:none;max-width:240px}
#hint{position:absolute;right:8px;bottom:8px;background:#000a;padding:4px 8px;border-radius:4px;font-size:11px;pointer-events:none;color:#bbb}
#loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#101012;color:#cbd2d8;font:13px Inter,system-ui,sans-serif;z-index:6}
.lspin{width:34px;height:34px;border:3px solid #2a3038;border-top-color:#19b9ff;border-radius:50%;animation:lspin .8s linear infinite}
@keyframes lspin{to{transform:rotate(360deg)}}
</style></head><body><div id="app">
<div id="hdr"><h1>World Map</h1><input id="q" placeholder="Search objects & NPCs\u2026">
<div class="fl"><button id="fdown" title="Floor down">\u25BE</button><span id="fl">Floor 0</span><button id="fup" title="Floor up">\u25B4</button></div>
<button id="follow" class="btn">\u25C9 Follow</button><button id="modeToggle" class="btn" title="Switch between overlay and window mode">\u21C6 ${host === "window" ? "Overlay" : "Window"}</button>${host === "overlay" ? '<button id="close" class="btn" title="Close">\u2715</button>' : ""}</div>
<div id="body"><div id="side"><div id="layers">
<label><input type="checkbox" id="L_ic" checked> Model icons</label>
<label><input type="checkbox" id="L_poi" checked> Minimap markers</label>
<label id="npcmode" style="cursor:pointer" title="Click to cycle: Off / Stored / Live">NPCs: <b id="npcmodelbl">Live</b></label>
<label><input type="checkbox" id="L_pl" checked> Players</label>
<label><input type="checkbox" id="L_lab"> Labels</label></div><div id="cats"></div></div>
<div id="view"><canvas id="c"></canvas><div id="tip"></div><div id="hint">drag to pan \xB7 scroll to zoom \xB7 click to walk</div><div id="loading"><div class="lspin"></div><div>Loading map\u2026</div></div></div></div></div>
<script>(function(){var D=${json};
var HOST=${JSON.stringify(host)};
var MOBILE=${this.isMobile};
/* One viewer, two hosts: a detached BrowserWindow talks over IPC; an in-page iframe overlay
   talks over postMessage. sendInput()/applyUpdate() abstract the transport so the rest of the
   viewer is identical in both. */
var IPC=(window.electron&&window.electron.ipcRenderer)?window.electron.ipcRenderer:null;
function sendInput(m){if(window.__wmInlineSend){window.__wmInlineSend(m);return;}if(IPC){IPC.send("map-window:input",m);}else{try{parent.postMessage({__wmInput:m},"*");}catch(e){}}}
var view=document.getElementById("view"),cv=document.getElementById("c"),ctx=cv.getContext("2d"),tip=document.getElementById("tip"),q=document.getElementById("q");
var terrain,ICONS,MM,ICONS_S;
function loadImgs(){terrain=new Image();terrain.onload=function(){var l=document.getElementById("loading");if(l)l.style.display="none";baseSig="";requestRender();};terrain.src=D.t;ICONS=(D.ic||[]).map(function(s){var i=new Image();i.src=s;return i;});ICONS_S=new Array(ICONS.length);MM=(D.mm||[]).map(function(s){var i=new Image();i.src=s;return i;});}
loadImgs();
/* Bake each icon's drop-shadow once into an offscreen canvas; per-icon shadowBlur in the
   draw loop is the single most expensive op, so we drop it and draw the pre-shadowed icon. */
function shadowed(idx){if(ICONS_S[idx])return ICONS_S[idx];var im=ICONS[idx];if(!im||!im.complete||!im.naturalWidth)return null;var pad=4;var c=document.createElement("canvas");c.width=im.naturalWidth+pad*2;c.height=im.naturalHeight+pad*2;var x=c.getContext("2d");x.shadowColor="rgba(0,0,0,.55)";x.shadowBlur=2;x.drawImage(im,pad,pad);ICONS_S[idx]=c;return c;}
var nameOn={};function taxState(){(D.ob||[]).forEach(function(o){if(nameOn[o.c+"|"+o.n]===undefined)nameOn[o.c+"|"+o.n]=true;});}taxState();
/* Which legend categories are expanded \u2014 persisted across rebuilds so a full-snapshot
   refresh (every ~7s) never collapses a dropdown the user opened. lastCatSig skips the
   rebuild entirely when the category/name set is unchanged. */
var catOpen={},lastCatSig="";
/* NPC name -> model-icon index, learned from full snapshots; light position-only updates
   reuse it so NPCs keep their 3D model icon between full snapshots. */
var npcIcon={};function buildNpcIcon(){(D.npc||[]).forEach(function(N){if(N.i!==undefined&&N.i>=0)npcIcon[N.n]=N.i;});}buildNpcIcon();
var showIcons=true,showPoi=true,showLab=false,npcMode=2,showPl=true,follow=true;
var cx=D.W/2,cz=D.H/2,Z=4,W=0,Hh=0,hits=[];
function clamp(v,a,b){return Math.max(a,Math.min(v,b));}
/* Render-on-demand: coalesce every change into a single rAF render instead of redrawing
   on a timer. Callers use requestRender(); render() does the actual draw. */
var _raf=null;function requestRender(){if(_raf)return;_raf=requestAnimationFrame(function(){_raf=null;render();});}
function resize(){var r=view.getBoundingClientRect();W=cv.width=Math.floor(r.width);Hh=cv.height=Math.floor(r.height);render();}
/* Static map content (terrain + object icons + POIs) is composited once into an offscreen
   base canvas and reused; it only rebuilds when a signature of view/data/filters changes.
   Dynamic overlays (NPCs, players, the player marker, the destination flag) draw on top
   every frame, so walking / the flag pulse just blits the base + a few dots. */
var base=document.createElement("canvas"),bctx=base.getContext("2d"),baseHits=[],baseSig="",nameVer=0,dataVer=0;
function buildBase(){base.width=W;base.height=Hh;bctx.clearRect(0,0,W,Hh);baseHits=[];
var sl=cx-W/(2*Z),st=cz-Hh/(2*Z);
if(terrain.complete&&terrain.naturalWidth){bctx.imageSmoothingEnabled=true;bctx.save();bctx.translate(-sl*Z,-st*Z);bctx.scale(Z,Z);bctx.drawImage(terrain,0,0);bctx.restore();}
if(D.wl&&D.wl.length){bctx.fillStyle="rgb(220,216,200)";var wt=Math.max(1.5,Z*0.15);for(var wi=0;wi<D.wl.length;wi+=3){var wx=D.wl[wi],wz=D.wl[wi+1],wf=D.wl[wi+2];var wsx=(wx-sl)*Z,wsy=(wz-st)*Z;if(wsx<-Z||wsx>W+Z||wsy<-Z||wsy>Hh+Z)continue;if(wf&1)bctx.fillRect(wsx,wsy,Z,wt);if(wf&4)bctx.fillRect(wsx,wsy+Z-wt,Z,wt);if(wf&8)bctx.fillRect(wsx,wsy,wt,Z);if(wf&2)bctx.fillRect(wsx+Z-wt,wsy,wt,Z);}}
if(showIcons){for(var j=0;j<D.ob.length;j++){var o=D.ob[j];if(nameOn[o.c+"|"+o.n]===false)continue;var sx=(o.x-sl)*Z,sy=(o.z-st)*Z;if(sx<-30||sx>W+30||sy<-30||sy>Hh+30)continue;
var hr;var sc=o.i>=0?shadowed(o.i):null;if(sc){var im=ICONS[o.i];var sz=clamp(Z*3,24,50);var k=sz/im.naturalWidth,dw=sc.width*k,dh=sc.height*k;bctx.globalAlpha=o.d?0.45:1;bctx.drawImage(sc,sx-dw/2,sy-dh/2,dw,dh);bctx.globalAlpha=1;hr=sz/2;}
else{var col=(D.ct.filter(function(c){return c.n==o.c;})[0]||{c:"#ffd24a"}).c;var br=clamp(Z*0.55,3,9);bctx.fillStyle=col;bctx.globalAlpha=o.d?0.4:1;bctx.beginPath();bctx.arc(sx,sy,br,0,6.28);bctx.fill();bctx.globalAlpha=1;hr=br;}
if(o.k>1){bctx.fillStyle="#c0392b";bctx.beginPath();bctx.arc(sx+hr*0.8,sy-hr*0.8,6,0,6.28);bctx.fill();bctx.fillStyle="#fff";bctx.font="9px sans-serif";bctx.textAlign="center";bctx.textBaseline="middle";bctx.fillText(o.k>9?"9+":""+o.k,sx+hr*0.8,sy-hr*0.8);}
baseHits.push({sx:sx,sy:sy,r:hr,n:o.n+(o.k>1?" +"+(o.k-1):""),s:o.c+" - "+o.x+","+o.z});
if(showLab){bctx.fillStyle="#fff";bctx.font="11px sans-serif";bctx.textAlign="center";bctx.textBaseline="bottom";bctx.shadowColor="#000";bctx.shadowBlur=3;bctx.fillText(o.n,sx,sy-hr-2);bctx.shadowBlur=0;}}}
if(showPoi){for(var p=0;p<D.pi.length;p++){var P=D.pi[p];var px=(P.x-sl)*Z,py=(P.z-st)*Z;if(px<-30||px>W+30||py<-30||py>Hh+30)continue;var u=P.s;
bctx.save();bctx.globalAlpha=0.7;bctx.fillStyle="rgba(0,0,0,.68)";bctx.beginPath();bctx.arc(px,py,u*0.55,0,6.28);bctx.fill();bctx.restore();
if(P.m>=0&&MM[P.m].complete&&MM[P.m].naturalWidth)bctx.drawImage(MM[P.m],px-u/2,py-u/2,u,u);baseHits.push({sx:px,sy:py,r:u/2,n:P.n,s:P.x+","+P.z});}}}
function render(){if(!W)return;
var sig=[cx,cz,Z,W,Hh,showIcons,showPoi,showLab,nameVer,dataVer].join(",");
if(sig!==baseSig){buildBase();baseSig=sig;}
ctx.clearRect(0,0,W,Hh);ctx.drawImage(base,0,0);hits=baseHits.slice();
var sl=cx-W/(2*Z),st=cz-Hh/(2*Z);
function drawNpc(N,alpha,tag){var nx=(N.x-sl)*Z,ny=(N.z-st)*Z;if(nx<-20||nx>W+20||ny<-20||ny>Hh+20)return;
var nii=(N.i!==undefined&&N.i>=0)?N.i:(npcIcon[N.n]!==undefined?npcIcon[N.n]:-1);var nsc=nii>=0?shadowed(nii):null;var nhr;ctx.globalAlpha=alpha;
if(nsc){var nim=ICONS[nii];var nsz=clamp(Z*2.6,20,44);var nk=nsz/nim.naturalWidth,ndw=nsc.width*nk,ndh=nsc.height*nk;ctx.drawImage(nsc,nx-ndw/2,ny-ndh/2,ndw,ndh);nhr=nsz/2;}
else{ctx.fillStyle=tag==="live"?"#f1c40f":"#9aa0a6";ctx.strokeStyle="rgba(0,0,0,.6)";ctx.lineWidth=1;ctx.beginPath();ctx.arc(nx,ny,4,0,6.28);ctx.fill();ctx.stroke();nhr=5;}
ctx.globalAlpha=1;hits.push({sx:nx,sy:ny,r:nhr,n:N.n+(N.l?" (lv "+N.l+")":"")+(tag==="stored"?" \xB7 last seen":""),s:"NPC - "+N.x+","+N.z});}
if(npcMode>0){
if(npcMode===1){var SN=D.ns||[];for(var si=0;si<SN.length;si++)drawNpc(SN[si],0.85,"stored");}
else{var LV=D.npc||[],SN2=D.ns||[];
for(var si2=0;si2<SN2.length;si2++){var S=SN2[si2],near=false;for(var li=0;li<LV.length;li++){var ddx=LV[li].x-S.x,ddz=LV[li].z-S.z;if(ddx*ddx+ddz*ddz<=16){near=true;break;}}if(!near)drawNpc(S,0.5,"stored");}
for(var li2=0;li2<LV.length;li2++)drawNpc(LV[li2],1,"live");}}
if(showPl&&D.pl){for(var pl2=0;pl2<D.pl.length;pl2++){var L=D.pl[pl2];var lx=(L.x-sl)*Z,ly=(L.z-st)*Z;if(lx<-10||lx>W+10||ly<-10||ly>Hh+10)continue;ctx.fillStyle="#2ecc71";ctx.strokeStyle="#fff";ctx.lineWidth=1;ctx.beginPath();ctx.arc(lx,ly,4,0,6.28);ctx.fill();ctx.stroke();hits.push({sx:lx,sy:ly,r:5,n:L.n,s:"Player - "+L.x+","+L.z});}}
if(D.dest){var dsx=(D.dest.x-sl)*Z,dsy=(D.dest.z-st)*Z;drawDest(ctx,dsx,dsy);}
if(D.p){var ppx=(D.p.x-sl)*Z,ppy=(D.p.z-st)*Z;ctx.save();ctx.fillStyle="#19b9ff";ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.beginPath();ctx.arc(ppx,ppy,6,0,6.28);ctx.fill();ctx.stroke();ctx.restore();}drawPings();}
var destT0=0,destRAF=null;
function drawDest(t,e,i){var s=(performance.now()-destT0)/1000,n=(Math.sin(s*8)+1)*.5,o=Math.max(0,1-s/.55);t.save();t.translate(e,i);t.lineJoin="round";
if(o>0){t.globalAlpha=.65*o;t.strokeStyle="#fff0b8";t.lineWidth=2;t.beginPath();t.arc(0,0,7+(1-o)*17,0,Math.PI*2);t.stroke();}
t.globalAlpha=.26+n*.2;t.strokeStyle="#ffdf64";t.lineWidth=1.75;t.shadowColor="rgba(255,210,80,0.55)";t.shadowBlur=3+n*2;t.beginPath();t.arc(0,0,7.5+n*1.2,0,Math.PI*2);t.stroke();t.globalAlpha=1;t.shadowBlur=0;t.lineCap="square";
t.strokeStyle="rgba(0,0,0,0.72)";t.lineWidth=3;t.beginPath();t.moveTo(0,-17);t.lineTo(0,0);t.stroke();
t.strokeStyle="#f7ead1";t.lineWidth=1.5;t.beginPath();t.moveTo(0,-17);t.lineTo(0,0);t.stroke();
t.fillStyle="#d8372b";t.strokeStyle="#230b07";t.lineWidth=1.25;t.shadowColor="rgba(0,0,0,0.35)";t.shadowBlur=2;t.beginPath();t.moveTo(1,-17);t.lineTo(10,-14);t.lineTo(1,-10);t.closePath();t.fill();t.stroke();t.restore();}
/* Pulse the destination flag at ~22fps (coalesced) instead of a full 60fps re-render. */
function destAnim(){if(D.dest){requestRender();destRAF=setTimeout(destAnim,45);}else destRAF=null;}
function ensureDestAnim(){if(D.dest&&!destRAF){destT0=performance.now();destAnim();}}
/* Legend ping: clicking a legend icon pulses a yellow glow ring around every matching
   object so you can spot them. 3 pulses (~650ms each) then it stops. */
var pingPts=null,pingT0=0,pingRAF=null,PING_PULSES=3,PING_DUR=650;
function pingObjects(pts){if(!pts||!pts.length)return;pingPts=pts;pingT0=performance.now();if(!pingRAF)pingAnim();}
function pingAnim(){if(pingPts&&(performance.now()-pingT0)<PING_PULSES*PING_DUR){requestRender();pingRAF=setTimeout(pingAnim,33);}else{pingPts=null;pingRAF=null;requestRender();}}
function drawPings(){if(!pingPts)return;var el=performance.now()-pingT0;if(el>=PING_PULSES*PING_DUR){pingPts=null;return;}
var ph=(el%PING_DUR)/PING_DUR,a=1-ph,sl=cx-W/(2*Z),st=cz-Hh/(2*Z);
var r0=Math.max(9,Z*1.5),rad=r0+ph*Math.max(13,Z*1.5);
ctx.save();ctx.lineWidth=Math.max(2,Z*0.16);ctx.strokeStyle="rgba(255,226,72,"+(0.95*a)+")";ctx.shadowColor="rgba(255,216,60,0.95)";ctx.shadowBlur=10*a+5;
for(var i=0;i<pingPts.length;i++){var px=(pingPts[i][0]-sl)*Z,py=(pingPts[i][1]-st)*Z;if(px<-40||px>W+40||py<-40||py>Hh+40)continue;ctx.beginPath();ctx.arc(px,py,rad,0,6.28);ctx.stroke();}
ctx.restore();}
function fit(){var pad=10;Z=clamp(Math.min(W/(D.W+pad),Hh/(D.H+pad)),0.3,48);cx=D.W/2;cz=D.H/2;render();}
function goTo(x,z){Z=Math.max(Z,16);cx=x+0.5;cz=z+0.5;render();}
/* Drag-vs-click (option C): panning only engages on a deliberate drag \u2014 moved past a
   generous threshold AND held a moment (or a big fast sweep). A quick tap, even with a few
   px of drift, stays a click \u2192 walk there. Click-to-move is handled on mouseup, not the
   browser 'click' event, so drift never eats the click. */
var dragging=false,pressed=false,sx0=0,sy0=0,lx0=0,ly0=0,pressT=0,DRAG_THRESH=18,HOLD_MS=150;
function clickAt(e){var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
var best=null,bd=1e9;for(var i=hits.length-1;i>=0;i--){var h=hits[i],d=(h.sx-mx)*(h.sx-mx)+(h.sy-my)*(h.sy-my);if(d<(h.r+4)*(h.r+4)&&d<bd){bd=d;best=h;}}
var sl=cx-W/(2*Z),st=cz-Hh/(2*Z);var wx=sl+mx/Z,wz=st+my/Z;
if(best){var m=best.s.match(/(-?\\d+),(-?\\d+)/);if(m){goTo(parseInt(m[1]),parseInt(m[2]));}}
else if(D.online){sendInput({t:"move",x:wx,z:wz});}}
view.addEventListener("mousedown",function(e){if(e.button!==0)return;pressed=true;dragging=false;sx0=lx0=e.clientX;sy0=ly0=e.clientY;pressT=Date.now();});
window.addEventListener("mouseup",function(e){var pth=(e.composedPath&&e.composedPath())||[];var onView=view===e.target||view.contains(e.target)||pth.indexOf(view)>=0;if(pressed&&!dragging&&onView)clickAt(e);pressed=false;dragging=false;view.classList.remove("drag");});
view.addEventListener("mousemove",function(e){if(pressed){if(!dragging){var dist=Math.abs(e.clientX-sx0)+Math.abs(e.clientY-sy0);if((dist>DRAG_THRESH&&(Date.now()-pressT)>HOLD_MS)||dist>DRAG_THRESH*3){dragging=true;setFollow(false);view.classList.add("drag");}}if(dragging){cx-=(e.clientX-lx0)/Z;cz-=(e.clientY-ly0)/Z;lx0=e.clientX;ly0=e.clientY;requestRender();tip.style.display="none";}return;}
var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,best=null,bd=1e9;for(var i=hits.length-1;i>=0;i--){var h=hits[i],d=(h.sx-mx)*(h.sx-mx)+(h.sy-my)*(h.sy-my);if(d<(h.r+4)*(h.r+4)&&d<bd){bd=d;best=h;}}
if(best){tip.style.display="block";tip.style.left=(mx+14)+"px";tip.style.top=(my+10)+"px";tip.innerHTML="<b>"+best.n+"</b><br>"+best.s;}else tip.style.display="none";});
view.addEventListener("wheel",function(e){e.preventDefault();var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;var wx=cx-W/(2*Z)+mx/Z,wz=cz-Hh/(2*Z)+my/Z;var f=e.deltaY<0?1.15:1/1.15;Z=clamp(Z*f,0.3,48);cx=wx+W/(2*Z)-mx/Z;cz=wz+Hh/(2*Z)-my/Z;render();},{passive:false});
view.addEventListener("contextmenu",function(e){e.preventDefault();var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;var wx=cx-W/(2*Z)+mx/Z,wz=cz-Hh/(2*Z)+my/Z;var textToCopy="("+Math.round(wx)+","+Math.round(wz)+")";var best=null,bd=1e9;for(var i=hits.length-1;i>=0;i--){var h=hits[i],d=(h.sx-mx)*(h.sx-mx)+(h.sy-my)*(h.sy-my);if(d<(h.r+4)*(h.r+4)&&d<bd){bd=d;best=h;}}if(best){textToCopy+="["+best.n.replace(/\\s*\\+\\d+$/,"").trim()+"]";}var m=document.getElementById("eq-map-context-menu");if(m)m.remove();m=document.createElement("div");m.id="eq-map-context-menu";m.style.cssText="position:fixed;left:"+e.clientX+"px;top:"+e.clientY+"px;background:#473e32;border:1px solid #1a1612;border-top-color:#72624d;border-left-color:#72624d;z-index:10000;box-shadow:2px 2px 4px rgba(0,0,0,0.5);user-select:none;min-width:120px;font-family:sans-serif;";var hdr=document.createElement("div");hdr.style.cssText="background:#362e24;padding:4px 8px;border-bottom:1px solid #1a1612;color:#ffd24a;font-weight:bold;text-align:center;font-size:12px;cursor:default";hdr.textContent="Select an Option";m.appendChild(hdr);var itm=document.createElement("div");itm.style.cssText="padding:6px 10px;cursor:pointer;color:#fff;font-size:13px";itm.textContent="Share "+textToCopy;itm.onmouseenter=function(){itm.style.background="#5c5040";};itm.onmouseleave=function(){itm.style.background="transparent";};itm.onclick=function(ev){ev.stopPropagation();m.remove();if(typeof sendInput!=="undefined"){sendInput({t:"chat",text:textToCopy});}else if(window.electron&&window.electron.ipcRenderer){window.electron.ipcRenderer.send("map-window:input",{t:"chat",text:textToCopy});}};m.appendChild(itm);document.body.appendChild(m);var closeM=function(ev){var pth=(ev.composedPath&&ev.composedPath())||[];if(!m.contains(ev.target)&&pth.indexOf(m)<0){m.remove();window.removeEventListener("mousedown",closeM);}};setTimeout(function(){window.addEventListener("mousedown",closeM);},0);});
function setFollow(on){follow=on&&!!D.online;var b=document.getElementById("follow");b.className="btn"+(D.online?"":" dis")+(follow?"":" off");b.innerText=(follow?"\u25C9":"\u25CB")+" Follow";if(follow&&D.p){cx=D.p.x+0.5;cz=D.p.z+0.5;render();}}
document.getElementById("follow").onclick=function(){if(!D.online)return;setFollow(!follow);};
document.getElementById("fdown").onclick=function(){sendInput({t:"floor",f:(D.floor||0)-1});};
document.getElementById("fup").onclick=function(){sendInput({t:"floor",f:(D.floor||0)+1});};
var _mt=document.getElementById("modeToggle");if(_mt)_mt.onclick=function(){sendInput({t:"mode"});};
var _cb=document.getElementById("close");if(_cb)_cb.onclick=function(){sendInput({t:"close"});};
document.getElementById("L_ic").onchange=function(e){showIcons=e.target.checked;render();};
document.getElementById("L_poi").onchange=function(e){showPoi=e.target.checked;render();};
var NPCLBL=["Off","Stored","Live"];function setNpcMode(m){npcMode=((m%3)+3)%3;var el=document.getElementById("npcmodelbl");if(el)el.textContent=NPCLBL[npcMode];requestRender();}
document.getElementById("npcmode").onclick=function(){setNpcMode(npcMode+1);};setNpcMode(2);
document.getElementById("L_pl").onchange=function(e){showPl=e.target.checked;render();};
document.getElementById("L_lab").onchange=function(e){showLab=e.target.checked;render();};
q.oninput=function(){var s=q.value.trim().toLowerCase();if(!s)return;var best=null,bd=1e9;function consider(x,z,n){if(n.toLowerCase().indexOf(s)<0)return;var d=(x-cx)*(x-cx)+(z-cz)*(z-cz);if(d<bd){bd=d;best=[x,z];}}D.ob.forEach(function(o){consider(o.x,o.z,o.n+" "+o.c);});(D.npc||[]).forEach(function(N){consider(N.x,N.z,N.n);});D.pi.forEach(function(P){consider(P.x,P.z,P.n);});if(best)goTo(best[0],best[1]);};
function esc(t){var d=document.createElement("span");d.textContent=t;return d.innerHTML;}
function buildCats(){var box=document.getElementById("cats");var TAX={};D.ob.forEach(function(o){if(!TAX[o.c])TAX[o.c]={};TAX[o.c][o.n]=(TAX[o.c][o.n]||0)+o.k;});
var sig=Object.keys(TAX).sort().map(function(c){return c+":"+Object.keys(TAX[c]).sort().join(",");}).join("|");
if(sig===lastCatSig)return; /* unchanged \u2192 keep current DOM (expand + scroll state) */
lastCatSig=sig;box.innerHTML="";
var catIcon={},nameIcon={};D.ob.forEach(function(o){if(o.i>=0){if(catIcon[o.c]===undefined)catIcon[o.c]=o.i;if(nameIcon[o.c+"|"+o.n]===undefined)nameIcon[o.c+"|"+o.n]=o.i;}});
var swatch=function(i,col){return i!==undefined?"<img class=ci src=\\""+D.ic[i]+"\\">":"<span class=sw style=background:"+col+"></span>";};
Object.keys(TAX).sort().forEach(function(c){var col=(D.ct.filter(function(x){return x.n==c;})[0]||{c:"#ffd24a"}).c;var names=Object.keys(TAX[c]).sort();var tot=0;names.forEach(function(n){tot+=TAX[c][n];});
var g=document.createElement("div");g.className="cat";var head=document.createElement("div");head.className="chead";
head.innerHTML="<input type=checkbox class=cc checked>"+swatch(catIcon[c],col)+"<span class=cn>"+esc(c)+" ("+tot+")</span><span class=exp>"+(catOpen[c]?"\u25BE":"\u25B8")+"</span>";
var subs=document.createElement("div");subs.className="subs";subs.style.display=catOpen[c]?"block":"none";
names.forEach(function(n){var l=document.createElement("label");l.className="sub";l.innerHTML="<input type=checkbox class=nc "+(nameOn[c+"|"+n]===false?"":"checked")+">"+swatch(nameIcon[c+"|"+n],col)+esc(n)+" ("+TAX[c][n]+")";
var nb=l.querySelector("input");nb.onchange=function(){nameOn[c+"|"+n]=nb.checked;var any=names.some(function(x){return nameOn[c+"|"+x]!==false;});head.querySelector(".cc").checked=any;nameVer++;render();};
var nsw=l.querySelector(".ci,.sw");if(nsw){nsw.style.cursor="pointer";nsw.title="Ping on map";nsw.onclick=function(ev){ev.stopPropagation();ev.preventDefault();if(!nb.checked){nb.checked=true;nameOn[c+"|"+n]=true;head.querySelector(".cc").checked=true;nameVer++;}var pts=[];D.ob.forEach(function(o){if(o.c===c&&o.n===n)pts.push([o.x,o.z]);});pingObjects(pts);render();};}
subs.appendChild(l);});
var cc=head.querySelector(".cc");cc.onchange=function(){var on=cc.checked;names.forEach(function(n){nameOn[c+"|"+n]=on;});subs.querySelectorAll(".nc").forEach(function(x){x.checked=on;});nameVer++;render();};
var chSw=head.querySelector(".ci,.sw");if(chSw){chSw.style.cursor="pointer";chSw.title="Ping on map";chSw.onclick=function(ev){ev.stopPropagation();ev.preventDefault();if(!cc.checked){cc.checked=true;names.forEach(function(n){nameOn[c+"|"+n]=true;});subs.querySelectorAll(".nc").forEach(function(x){x.checked=true;});nameVer++;}var pts=[];D.ob.forEach(function(o){if(o.c===c&&nameOn[c+"|"+o.n]!==false)pts.push([o.x,o.z]);});pingObjects(pts);render();};}
head.querySelector(".exp").onclick=function(){var open=subs.style.display==="none";subs.style.display=open?"block":"none";this.textContent=open?"\u25BE":"\u25B8";catOpen[c]=open;};
g.appendChild(head);g.appendChild(subs);box.appendChild(g);});}
function setLabel(){document.getElementById("fl").innerText="Floor "+(D.floor||0);}
function applyUpdate(u){if(!u)return;
if(u.full){var nd=u.full;D=nd;loadImgs();taxState();buildNpcIcon();buildCats();setLabel();dataVer++;}
if(u.terrain){D.t=u.terrain;terrain=new Image();terrain.onload=function(){baseSig="";requestRender();};terrain.src=u.terrain;}
if(u.p!==undefined)D.p=u.p;if(u.npc!==undefined)D.npc=u.npc;if(u.pl!==undefined)D.pl=u.pl;if(u.online!==undefined)D.online=u.online;
if(u.dest!==undefined){var had=!!D.dest;D.dest=u.dest;if(D.dest&&!had)destT0=performance.now();}
setFollow(follow);if(follow&&D.p){cx=D.p.x+0.5;cz=D.p.z+0.5;}if(u.goTo){setFollow(false);goTo(u.goTo.x,u.goTo.z);}ensureDestAnim();requestRender();}
if(IPC&&IPC.on)IPC.on("map-window:update",function(e,u){applyUpdate(u);});
window.addEventListener("message",function(e){var d=e&&e.data;if(d&&d.__wmUpdate)applyUpdate(d.__wmUpdate);});
buildCats();setLabel();setFollow(true);ensureDestAnim();
window.addEventListener("resize",resize);[terrain].concat(ICONS,MM).forEach(function(im){im.addEventListener("load",requestRender);});setTimeout(render,300);setTimeout(render,1200);
if(MOBILE){(function(){
var ms=document.createElement("style");ms.textContent=
"#hdr h1{display:none}#hdr{flex-wrap:wrap;gap:5px;padding:5px 8px}"
+"#q{flex:1 1 120px;font-size:15px;padding:7px 8px}#modeToggle{display:none!important}"
+".btn{padding:7px 10px;font-size:13px}#hint{display:none}#body{position:relative}"
+"#side{position:absolute;left:0;top:0;bottom:0;z-index:7;max-width:80%;overflow:auto;transform:translateX(-100%);transition:transform .2s;box-shadow:2px 0 12px rgba(0,0,0,.5)}"
+"body.side-open #side{transform:translateX(0)}"
+"#legendToggle{position:absolute;left:8px;top:8px;z-index:8;width:40px;height:40px;border:none;border-radius:8px;background:rgba(20,20,24,.85);color:#fff;font-size:20px;cursor:pointer}"
+"#zoomBtns{position:absolute;right:10px;bottom:14px;z-index:8;display:flex;flex-direction:column;gap:10px}"
+"#zoomBtns button{width:46px;height:46px;border:none;border-radius:10px;background:rgba(20,20,24,.85);color:#fff;font-size:24px;cursor:pointer}";
document.head.appendChild(ms);
var lt=document.createElement("button");lt.id="legendToggle";lt.textContent="\\u2630";lt.onclick=function(){document.body.classList.toggle("side-open");};view.appendChild(lt);
var zb=document.createElement("div");zb.id="zoomBtns";var zi=document.createElement("button");zi.textContent="+";var zo=document.createElement("button");zo.textContent="\\u2212";zb.appendChild(zi);zb.appendChild(zo);view.appendChild(zb);
function zoomBy(f){Z=clamp(Z*f,0.3,48);render();}zi.onclick=function(){zoomBy(1.4);};zo.onclick=function(){zoomBy(1/1.4);};
var tP=false,tD=false,x0=0,y0=0,lx=0,ly=0,lp=null,pin=false,pd=0,pz=0;
view.addEventListener("touchstart",function(e){
 if(e.touches.length===2){pin=true;tP=false;if(lp){clearTimeout(lp);lp=null;}var a=e.touches[0],b=e.touches[1];pd=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);pz=Z;return;}
 var t=e.touches[0];tP=true;tD=false;x0=lx=t.clientX;y0=ly=t.clientY;
 if(lp)clearTimeout(lp);lp=setTimeout(function(){if(tP&&!tD){tP=false;view.dispatchEvent(new MouseEvent("contextmenu",{clientX:x0,clientY:y0,bubbles:true,cancelable:true}));}},500);
},{passive:true});
view.addEventListener("touchmove",function(e){
 if(pin&&e.touches.length>=2){var a=e.touches[0],b=e.touches[1];var d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);if(pd>0){Z=clamp(pz*(d/pd),0.3,48);render();}e.preventDefault();return;}
 if(!tP)return;var t=e.touches[0];var dd=Math.abs(t.clientX-x0)+Math.abs(t.clientY-y0);
 if(!tD&&dd>12){tD=true;if(lp){clearTimeout(lp);lp=null;}setFollow(false);}
 if(tD){cx-=(t.clientX-lx)/Z;cz-=(t.clientY-ly)/Z;lx=t.clientX;ly=t.clientY;requestRender();tip.style.display="none";e.preventDefault();}
},{passive:false});
view.addEventListener("touchend",function(e){if(lp){clearTimeout(lp);lp=null;}
 if(pin){if(e.touches.length===0)pin=false;return;}
 if(tP&&!tD){clickAt({clientX:x0,clientY:y0});}tP=false;tD=false;
},{passive:true});
})();}
resize();fit();})();<\/script></body></html>`;
  }
  /** Save text to a file via a download link (lands in the user's Downloads). */
  downloadFile(name, content) {
    try {
      const blob = new Blob([content], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4e3);
    } catch (e) {
      this.warn("export download failed: " + (e?.message || e));
    }
  }
  /**
   * Icon lookup order (cache-first, render-on-miss): in-memory → persisted
   * localStorage → runtime render. The persisted layer is the same data the
   * EvilLite devs would pre-bake and ship with the client, so most users never
   * run the offscreen renderer — but if the game adds new content before a new
   * cache is shipped, runtime generation fills the gap automatically.
   */
  async initIconSystem() {
    if (this.bjsState !== "idle") return;
    this.bjsState = "init";
    try {
      await this.loadPersistedIcons();
      if (this.isMobile) {
        this.bjsState = "failed";
        this.info("icons: mobile \u2014 prebaked cache only (no live render)");
        return;
      }
      const gm = this.gm;
      if (!gm?.scene) {
        this.bjsState = "idle";
        return;
      }
      let url = "";
      for (const el of Array.from(document.querySelectorAll('link[rel="modulepreload"],script[src]'))) {
        const src = el.href || el.src || "";
        if (/babylon-core[-.][A-Za-z0-9_]+\.js/.test(src)) {
          url = src;
          break;
        }
      }
      if (!url) {
        this.bjsState = "failed";
        this.warn("icons: babylon-core URL not found");
        return;
      }
      const ns = await import(
        /* @vite-ignore */
        url
      );
      const vals = Object.values(ns);
      const SceneLoader = vals.find((v) => v && typeof v.ImportMeshAsync === "function");
      const Vector3 = vals.find((v) => typeof v === "function" && typeof v.Minimize === "function" && typeof v.Maximize === "function" && typeof v.Zero === "function");
      const ArcRotateCamera = vals.find((v) => typeof v === "function" && v.prototype && typeof v.prototype.rebuildAnglesAndRadius === "function");
      this.sendDiag(`init classes SceneLoader:${!!SceneLoader} Vector3:${!!Vector3} ArcRotateCamera:${!!ArcRotateCamera}`);
      if (!SceneLoader || !Vector3 || !ArcRotateCamera) {
        this.bjsState = "failed";
        this.warn("icons: required Babylon classes not found");
        return;
      }
      this.bjs = { SceneLoader, SceneClass: gm.scene.constructor, EngineClass: gm.scene.getEngine().constructor, Vector3, ArcRotateCamera };
      this.parseModelTables();
      this.bjsState = "ready";
      this.info(`icons: ready (${this.objModelFiles?.size ?? 0} object + ${this.npcModelFiles?.size ?? 0} npc models)`);
    } catch (e) {
      this.bjsState = "failed";
      this.warn("icons: init failed \u2014 " + (e?.message || e));
    }
  }
  /** Load the prebaked icon cache (key -> dataURL) from the main process. In a shipped
   *  build this is the cache compiled into the client; in dev it's the JSON file we've
   *  been accumulating. Either way, cached icons skip the expensive runtime render. */
  async loadPersistedIcons() {
    try {
      const icons = await this.iconCacheStore.load();
      if (!icons) return;
      for (const key of Object.keys(icons)) {
        const img = new Image();
        img.src = icons[key];
        this.iconCache.set(key, img);
      }
      this.info(`icons: loaded ${Object.keys(icons).length} from cache`);
    } catch {
    }
  }
  parseModelTables() {
    this.objModelFiles = /* @__PURE__ */ new Map();
    this.npcModelFiles = /* @__PURE__ */ new Map();
    const src = window.__eqSourceCode || "";
    for (const m of src.matchAll(/(?:\bdefId\s*:\s*|['"]?id['"]?\s*:\s*)(\d+)[^}]*?(?:file|files|model|modelPath|assetId)['"]?\s*:\s*(?:\[\s*)?['"]([^'"]+\.(?:glb|gltf))['"]/gi)) {
      const id = Number(m[1]);
      if (!this.objModelFiles.has(id)) this.objModelFiles.set(id, m[2]);
    }
    for (const m of src.matchAll(/(\d+)\s*:\s*\{(?:(?!\d+\s*:\s*\{)[\s\S])*?['"]([^'"]+\.(?:glb|gltf))['"]/gi)) {
      const id = Number(m[1]);
      if (!this.npcModelFiles.has(id)) this.npcModelFiles.set(id, m[2]);
    }
    this.modelFileCache.clear();
  }
  resolveModelUrl(file) {
    const origin = "https://evilquest.net";
    if (/^https?:/i.test(file)) return file;
    const enc = file.split("/").map((s) => /%[0-9a-f]{2}/i.test(s) ? s : encodeURIComponent(s)).join("/");
    if (file.startsWith("/")) return origin + enc;
    return origin + "/models/" + enc;
  }
  /** Find the first `.glb` path anywhere in a def object (handles unknown field
   *  names + nested arrays/objects, so it survives EvilQuest renaming fields). */
  findGlb(def, depth = 0) {
    if (!def || typeof def !== "object" || depth > 2) return null;
    const isGlb = (s) => typeof s === "string" && _WorldMapPlugin.MODEL_EXT.test(s);
    for (const v of Object.values(def)) if (isGlb(v)) return v;
    for (const v of Object.values(def)) {
      if (Array.isArray(v)) {
        for (const e of v) {
          if (isGlb(e)) return e;
          const f = this.findGlb(e, depth + 1);
          if (f) return f;
        }
      } else if (v && typeof v === "object") {
        const f = this.findGlb(v, depth + 1);
        if (f) return f;
      }
    }
    return null;
  }
  /** Model file for a marker — live cached def first (authoritative, update-proof),
   *  then the regex-parsed source tables as a fallback. Returns null if the def
   *  isn't loaded yet (so we retry) or genuinely has no model (cached, falls back
   *  to a shape). */
  modelFileFor(kind, defId) {
    const key = `${kind}:${defId}`;
    if (this.modelFileCache.has(key)) return this.modelFileCache.get(key);
    let def = null;
    try {
      def = kind === "obj" ? this.gm?.objectDefsCache?.get(defId) : this.gm?.entities?.npcDefsCache?.get(defId);
    } catch {
    }
    if (!def) return null;
    const table = kind === "obj" ? this.objModelFiles : this.npcModelFiles;
    if (!table) return null;
    const file = this.findGlb(def) ?? table.get(defId) ?? null;
    if (file) this.modelFileCache.set(key, file);
    return file;
  }
  /** Log assetId/regPath for each object category the first time one of its meshes
   *  loads nearby (so we can confirm e.g. whether altars have a model at all). */
  probeNewObjectCategories() {
    if (this.probeDeadline === 0) this.probeDeadline = performance.now() + 12e4;
    if (performance.now() > this.probeDeadline) return;
    const wod = this.gm?.worldObjectDefs;
    const models = this.getWorldObjectModels();
    const defs = this.gm?.objectDefsCache;
    if (!wod || !models) return;
    let scanned = 0;
    for (const [k, r] of wod) {
      if (++scanned > 4e3) break;
      const cat = (defs?.get(r?.defId)?.category ?? "") + "";
      if (!cat || this.probedObjCats.has(cat)) continue;
      const mdl = models.get(k);
      if (!mdl) continue;
      this.probedObjCats.add(cat);
      const aid = this.assetIdFromModel(mdl);
      this.sendDiag(`OBJPROBE cat=${cat} defName=${defs?.get(r?.defId)?.name} placedName=${mdl?.metadata?.placedName} assetId=${aid} regPath=${this.objAssetFile(aid)}`);
    }
  }
  /** One-shot dump of real def shapes so we can see where trees/humans keep their
   *  model (logged via eq-diag → main process). Fires once after defs are loaded. */
  dumpModelDiag() {
    if (this.diagDumped) return;
    this.diagDumped = true;
    try {
      const wod = this.gm?.worldObjectDefs;
      const rec = wod?.values?.().next?.().value;
      const reg = this.getAssetRegistry();
      this.sendDiag(`PLACEDREC keys=[${rec ? Object.keys(rec).join(",") : "none"}] metaKeys=[${rec?.metadata ? Object.keys(rec.metadata).join(",") : "none"}] assetId=${rec?.metadata?.assetId ?? rec?.assetId} registry=${!!reg} regSize=${reg?.size}`);
      const models = this.getWorldObjectModels();
      const defsC = this.gm?.objectDefsCache;
      const seenProbeCat = /* @__PURE__ */ new Set();
      if (wod && models) {
        for (const [k, r] of wod) {
          const mdl = models.get(k);
          if (!mdl) continue;
          const cat = (defsC?.get(r?.defId)?.category ?? "?") + "";
          if (seenProbeCat.has(cat)) continue;
          seenProbeCat.add(cat);
          const aid = this.assetIdFromModel(mdl);
          this.sendDiag(`WOMODEL cat=${cat} name=${defsC?.get(r?.defId)?.name} assetId=${aid} regPath=${this.objAssetFile(aid)}`);
          if (seenProbeCat.size >= 14) break;
        }
      }
      this.sendDiag(`WOMODELS size=${models?.size ?? "none"}`);
      this.sendDiag(`TABLES obj=${this.objModelFiles?.size} npc=${this.npcModelFiles?.size} live=${this.liveNpcs.length} | cow10=${this.modelFileFor("npc", 10)} chicken1=${this.modelFileFor("npc", 1)} bull24=${this.modelFileFor("npc", 24)}`);
    } catch (e) {
      this.sendDiag(`PLACEDREC err ${e?.message || e}`);
    }
    const seenCat = /* @__PURE__ */ new Set();
    for (const o of this.objectStore.values()) {
      if (seenCat.has(o.category)) continue;
      seenCat.add(o.category);
      const def = this.gm?.objectDefsCache?.get(o.defId);
      const glb = this.findGlb(def);
      this.sendDiag(`OBJDEF ${o.category}/${o.name} #${o.defId} glb=${glb} keys=[${def ? Object.keys(def).join(",") : "none"}]`);
      if (def && !glb) this.sendDiag(`  OBJRAW ${JSON.stringify(def).slice(0, 600)}`);
    }
    let n = 0;
    for (const [defId, m] of this.npcStore) {
      if (n++ > 8) break;
      const first = m.values().next().value;
      const def = this.gm?.entities?.npcDefsCache?.get(defId);
      const glb = this.findGlb(def);
      this.sendDiag(`NPCDEF ${first?.name} #${defId} glb=${glb} keys=[${def ? Object.keys(def).join(",") : "none"}]`);
      if (def && !glb) this.sendDiag(`  NPCRAW ${JSON.stringify(def).slice(0, 600)}`);
    }
  }
  /** The game's asset registry: assetId -> { path } (the real placed-object model). */
  getAssetRegistry() {
    return this.gm?.chunkManager?.assetRegistry ?? this.gm?.assetRegistry ?? null;
  }
  /** worldObjectKey -> loaded model node (whose metadata.assetId we want). */
  getWorldObjectModels() {
    return this.gm?.worldObjectModels ?? this.gm?.chunkManager?.worldObjectModels ?? null;
  }
  /** Pull assetId off a loaded world-object model node (root, parent, or a child). */
  assetIdFromModel(model) {
    if (!model) return "";
    let a = model.metadata?.assetId ?? model.parent?.metadata?.assetId;
    if (!a && typeof model.getChildMeshes === "function") {
      for (const c of model.getChildMeshes(false)) {
        if (c?.metadata?.assetId) {
          a = c.metadata.assetId;
          break;
        }
      }
    }
    return typeof a === "string" ? a : "";
  }
  objAssetFile(assetId) {
    if (!assetId) return null;
    const path = this.getAssetRegistry()?.get(assetId)?.path;
    if (typeof path !== "string" || !_WorldMapPlugin.MODEL_EXT.test(path)) return null;
    return /^https?:/i.test(path) || path.startsWith("/") ? path : "/" + path;
  }
  /** Ready icon for an arbitrary key, or null — queuing a render on first miss.
   *  `resolveFile` is only called on a miss, lazily. */
  iconFor(key, resolveFile) {
    if (!this.iconsEnabled) return null;
    const cached = this.iconCache.get(key);
    if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
    if (this.iconFailed.has(key) || this.iconPending.has(key)) return null;
    if (this.bjsState === "idle") {
      void this.initIconSystem();
      return null;
    }
    if (this.bjsState !== "ready") return null;
    const file = resolveFile();
    if (!file) return null;
    this.iconPending.add(key);
    this.iconQueue.push({ key, file });
    void this.processIconQueue();
    return null;
  }
  /** Object icon, keyed by assetId (its real model identity); falls back to the
   *  legacy defId model table for the few objects defined that way (trees). */
  /** Longest common leading substring across the given strings. */
  commonPrefix(arr) {
    if (!arr.length) return "";
    let p = arr[0];
    for (const s of arr) {
      let i = 0;
      while (i < p.length && i < s.length && p[i] === s[i]) i++;
      p = p.slice(0, i);
      if (!p) break;
    }
    return p;
  }
  getObjectIcon(o) {
    let assetId = o.assetId;
    if (!assetId) {
      const seen = this.defIdAssets.get(o.defId);
      if (seen && seen.size) {
        if (seen.size === 1) {
          assetId = seen.values().next().value;
        } else {
          const arr = [...seen];
          if (this.commonPrefix(arr).length >= 4) assetId = arr[0];
        }
      }
    }
    const key = assetId ? "obj:" + assetId : "objdef:" + o.defId;
    const icon = this.iconFor(key, () => this.objAssetFile(assetId) ?? this.objModelFiles?.get(o.defId) ?? null);
    if (icon) {
      this.catRepIcon.set(o.category, icon);
      this.nameRepIcon.set(o.category + "\0" + o.name, icon);
    }
    return icon;
  }
  getNpcIcon(defId) {
    const cached = this.iconFor("npc:" + defId, () => null);
    if (cached) return cached;
    const file = this.modelFileFor("npc", defId);
    if (file) return this.iconFor("npc:" + defId, () => file);
    if (this.npcModelFiles?.has(defId)) return null;
    const def = this.gm?.entities?.npcDefsCache?.get(defId);
    if (def) {
      const glb = this.findGlb(def);
      if (glb) return this.iconFor("npc:" + defId, () => glb);
      return this.iconFor("npc:__humanoid__", () => _WorldMapPlugin.HUMANOID_MODEL);
    }
    return null;
  }
  /**
   * DEV TOOL: pre-render an icon for every model the def tables / asset registry
   * currently know about, so the prebaked cache can be completed without walking the
   * whole map. Trigger with Ctrl+Shift+B (dev builds only); also callable directly.
   *
   * Deliberately resilient and best-effort, because this WON'T hold forever:
   *   - EvilQuest plans to lock assets behind auth — any model that 404s / 401s just
   *     gets marked failed and skipped (per-model try/catch in processIconQueue), the
   *     pass keeps going, and the normal explore-as-you-go rendering still works.
   *   - It only bakes what the def/registry tables expose right now; if the game moves
   *     to streaming defs (so exploration is required again), this simply bakes less,
   *     and the on-demand path remains the source of truth.
   * Saves are dev-only (the main-process cache is read-only in packaged builds), so
   * running this in a shipped build renders in memory but writes nothing.
   */
  async renderAllIcons() {
    if (this.bulkRendering) {
      this.info("render-all: already running");
      return;
    }
    if (this.bjsState !== "ready") {
      void this.initIconSystem();
      this.warn("render-all: icon system not ready (need to be in-game) \u2014 try again in a moment");
      return;
    }
    this.bulkRendering = true;
    try {
      const jobs = /* @__PURE__ */ new Map();
      const add = (key, file) => {
        if (!key || !file) return;
        if (this.iconCache.has(key) || this.iconFailed.has(key) || this.iconPending.has(key) || jobs.has(key)) return;
        jobs.set(key, file);
      };
      const reg = this.getAssetRegistry();
      if (reg && typeof reg.forEach === "function") {
        reg.forEach((entry, assetId) => {
          const path = entry?.path;
          if (typeof assetId === "string" && typeof path === "string" && _WorldMapPlugin.MODEL_EXT.test(path)) {
            add("obj:" + assetId, this.objAssetFile(assetId) ?? path);
          }
        });
      }
      const objDefs = this.gm?.objectDefsCache;
      if (objDefs && typeof objDefs.forEach === "function") {
        objDefs.forEach((def, defId) => add("objdef:" + defId, this.findGlb(def) ?? this.objModelFiles?.get(Number(defId)) ?? null));
      }
      this.objModelFiles?.forEach((file, defId) => add("objdef:" + defId, file));
      const npcDefs = this.gm?.entities?.npcDefsCache;
      if (npcDefs && typeof npcDefs.forEach === "function") {
        npcDefs.forEach((_def, defId) => {
          const file = this.modelFileFor("npc", Number(defId));
          if (file) add("npc:" + defId, file);
          else add("npc:__humanoid__", _WorldMapPlugin.HUMANOID_MODEL);
        });
      }
      this.npcModelFiles?.forEach((file, defId) => add("npc:" + defId, file));
      const total = jobs.size;
      this.info(`render-all: queuing ${total} models (already have ${this.iconCache.size} cached, ${this.iconFailed.size} failed)`);
      this.sendDiag(`RENDER-ALL queuing ${total} (cached=${this.iconCache.size} failed=${this.iconFailed.size})`);
      if (!total) return;
      for (const [key, file] of jobs) {
        this.iconPending.add(key);
        this.iconQueue.push({ key, file });
      }
      await this.processIconQueue();
      this.info(`render-all: done \u2014 cache now ${this.iconCache.size}, failed ${this.iconFailed.size}`);
      this.sendDiag(`RENDER-ALL done cache=${this.iconCache.size} failed=${this.iconFailed.size}`);
    } finally {
      this.bulkRendering = false;
    }
  }
  async processIconQueue() {
    if (this.iconRendering || !this.bjs) return;
    if (Date.now() < this.iconQueuePausedUntil) return;
    this.iconRendering = true;
    try {
      while (this.iconQueue.length) {
        if (Date.now() < this.iconQueuePausedUntil) break;
        if (!this.bulkRendering && this.iconQueue.length > _WorldMapPlugin.MAX_ICON_QUEUE) {
          const dropped = this.iconQueue.splice(_WorldMapPlugin.MAX_ICON_QUEUE);
          for (const d of dropped) this.iconPending.delete(d.key);
        }
        const { key, file } = this.iconQueue.shift();
        try {
          const dataUrl = await this.renderModel(this.resolveModelUrl(file));
          if (dataUrl) {
            const img = new Image();
            img.src = dataUrl;
            this.iconCache.set(key, img);
            this.iconCacheStore.save(key, dataUrl);
            this.iconAuthFailStreak = 0;
          } else this.iconFailed.add(key);
        } catch (e) {
          this.iconFailed.add(key);
          this.lastIconDiag = `ERR ${key} ${file}: ${e?.message || e}`;
          this.sendDiag(`QUEUE-ERR ${key} ${file}: ${e?.message || e} :: ${(e?.stack || "").slice(0, 300)}`);
          if (/\b(401|403|unauthorized|forbidden)\b/i.test(`${e?.message || e}`)) {
            if (++this.iconAuthFailStreak >= 4) {
              this.iconQueue.length = 0;
              this.iconPending.clear();
              this.iconQueuePausedUntil = Date.now() + 90 * 1e3;
              this.sendDiag("icon queue paused 90s \u2014 model fetches returning auth errors (token likely expired)");
              this.iconPending.delete(key);
              break;
            }
          } else this.iconAuthFailStreak = 0;
        } finally {
          this.iconPending.delete(key);
        }
        if (++this.rendersSinceEngineReset >= _WorldMapPlugin.RENDERS_PER_ENGINE) {
          this.rendersSinceEngineReset = 0;
          try {
            this.offEngine?.dispose();
          } catch {
          }
          this.offEngine = null;
          this.offCanvas = null;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      this.iconRendering = false;
    }
  }
  sendDiag(m) {
    try {
      window.electron?.ipcRenderer?.send("eq-diag", m);
    } catch {
    }
  }
  async renderModel(fullUrl) {
    const { SceneLoader, SceneClass, EngineClass, Vector3, ArcRotateCamera } = this.bjs;
    const slash = fullUrl.lastIndexOf("/");
    const rootUrl = fullUrl.slice(0, slash + 1);
    const fileName = fullUrl.slice(slash + 1);
    const SIZE = 128;
    this.sendDiag(`render START ${fileName} SceneCtor:${!!SceneClass} EngineCtor:${!!EngineClass}`);
    if (!this.offEngine) {
      try {
        this.offCanvas = document.createElement("canvas");
        this.offCanvas.width = SIZE;
        this.offCanvas.height = SIZE;
        this.offEngine = new EngineClass(this.offCanvas, true, { preserveDrawingBuffer: true, stencil: false, alpha: true });
        this.sendDiag(`offEngine created ok webgl=${this.offEngine?.webGLVersion ?? "?"}`);
      } catch (e) {
        this.sendDiag(`offEngine FAILED: ${e?.message || e}`);
        throw e;
      }
    }
    let scene = null;
    try {
      scene = new SceneClass(this.offEngine);
      const Color4 = scene.clearColor.constructor;
      try {
        scene.clearColor = new Color4(0, 0, 0, 0);
      } catch {
      }
      this.sendDiag(`importing ${fileName} from ${rootUrl}`);
      const res = await SceneLoader.ImportMeshAsync("", rootUrl, fileName, scene);
      const meshes = (res?.meshes ?? []).filter((m) => (m?.getTotalVertices?.() ?? 0) > 0);
      this.lastIconDiag = `${fileName} meshes:${res?.meshes?.length ?? 0}/${meshes.length}`;
      if (!meshes.length) return null;
      for (const m of meshes) {
        try {
          m.isVisible = true;
          m.visibility = 1;
          m.setEnabled?.(true);
        } catch {
        }
      }
      for (const mat of scene.materials) {
        try {
          mat.backFaceCulling = false;
          if ("unlit" in mat) mat.unlit = true;
          if ("disableLighting" in mat) mat.disableLighting = true;
          const baseTex = mat.albedoTexture ?? mat.diffuseTexture ?? mat.emissiveTexture;
          if (baseTex && "emissiveTexture" in mat) mat.emissiveTexture = baseTex;
          const baseCol = mat.albedoColor ?? mat.diffuseColor;
          if (baseCol && "emissiveColor" in mat) mat.emissiveColor = baseCol.clone ? baseCol.clone() : baseCol;
          if ("emissiveIntensity" in mat) mat.emissiveIntensity = 1;
        } catch {
        }
      }
      try {
        scene.createDefaultLight?.(true);
      } catch {
      }
      const cam = new ArcRotateCamera("eqIconCam", Math.PI / 2 + 0.6, 1.15, 10, Vector3.Zero(), scene);
      scene.activeCamera = cam;
      cam.minZ = 1e-3;
      cam.maxZ = 1e5;
      await Promise.race([
        typeof scene.whenReadyAsync === "function" ? scene.whenReadyAsync() : Promise.resolve(),
        new Promise((r) => setTimeout(r, 5e3))
      ]);
      let center = Vector3.Zero();
      let bRadius = 1;
      try {
        let min = null, max = null;
        for (const m of meshes) {
          m.computeWorldMatrix?.(true);
          const bb = m.getBoundingInfo?.().boundingBox;
          if (!bb) continue;
          const lo = bb.minimumWorld, hi = bb.maximumWorld;
          if (!min) {
            min = lo.clone();
            max = hi.clone();
          } else {
            min.minimizeInPlace?.(lo);
            max.maximizeInPlace?.(hi);
          }
        }
        if (min && max) {
          center = min.add(max).scale(0.5);
          bRadius = Math.max(max.subtract(min).length() / 2, 0.05);
        }
      } catch {
      }
      const renderAt = (alpha, beta) => {
        cam.target = center.clone ? center.clone() : center;
        cam.alpha = alpha;
        cam.beta = beta;
        cam.radius = bRadius * 2.6;
        for (let i = 0; i < 3; i++) {
          try {
            scene.render();
          } catch {
          }
        }
        return this.offCanvas.toDataURL("image/png");
      };
      let best = renderAt(Math.PI / 2 + 0.6, 1.15);
      if (best.length < 1500) {
        for (const [a, b] of [[0.6, 1.15], [Math.PI + 0.6, 1.15], [-Math.PI / 2 + 0.6, 1.15], [Math.PI / 2 + 0.6, 0.35]]) {
          const url = renderAt(a, b);
          if (url.length > best.length) best = url;
          if (best.length >= 2500) break;
        }
      }
      this.lastIconDiag += ` len:${best.length}`;
      this.sendDiag(`toDataURL len:${best.length}`);
      if (best.length < 900) {
        try {
          const mats = scene.materials.map((m) => m?.getClassName?.() ?? typeof m).join(",");
          this.sendDiag(`BLANK ${fileName} meshes=${meshes.length} mats=[${mats}] bRadius=${bRadius.toFixed(3)} center=${center.x?.toFixed(2)},${center.y?.toFixed(2)},${center.z?.toFixed(2)}`);
        } catch {
        }
        return null;
      }
      return best;
    } finally {
      try {
        if (scene) {
          for (const t of (scene.textures ?? []).slice()) {
            try {
              t.dispose();
            } catch {
            }
          }
          for (const m of (scene.materials ?? []).slice()) {
            try {
              m.dispose(true, true);
            } catch {
            }
          }
          for (const g of (scene.geometries ?? []).slice()) {
            try {
              g.dispose();
            } catch {
            }
          }
          for (const mesh of (scene.meshes ?? []).slice()) {
            try {
              mesh.dispose(false, true);
            } catch {
            }
          }
          scene.dispose();
        }
      } catch {
      }
    }
  }
  getMmIcon(iconName) {
    if (!iconName) return null;
    if (this.mmIconCache.has(iconName)) return this.mmIconCache.get(iconName);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onerror = () => {
      this.mmIconCache.set(iconName, null);
    };
    img.src = `https://evilquest.net/minimap/icons/${encodeURIComponent(iconName)}`;
    this.mmIconCache.set(iconName, img);
    return img;
  }
  setStatus(text) {
    if (this.statusEl) this.statusEl.innerText = text;
  }
};
// Plugin sidebar (highlite_bar) icon — added while the plugin is enabled, removed on
// disable. Clicking it toggles the map, exactly like pressing M.
_WorldMapPlugin.MENU_ICON = "\u{1F5FA}\uFE0F";
_WorldMapPlugin.MAX_SESSION_NPCS = 2e3;
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
// Base tile-type colors — match game's `ga` table exactly.
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
// Nf
_WorldMapPlugin.ROOF_COLOR = [96, 64, 34];
_WorldMapPlugin.RENDERS_PER_ENGINE = 20;
/** Model file extensions Babylon's loader can import for our icons. The game's
 *  bought-asset packs (e.g. Medieval_Dracula: Lamp, Coffin, Notice Board) ship as
 *  .gltf, not .glb — accept both or those objects fall back to plain dots. */
_WorldMapPlugin.MODEL_EXT = /\.(glb|gltf)(\?|#|$)/i;
// Equipment-assembled humanoid NPCs (bankers, farmers, shopkeepers, vampires,
// skeleton warriors, custom humanoids…) carry NO model file. The game builds them
// from this generic base body (per the ThumbnailRenderer), so we render it once and
// share it as their icon — a real 3D person instead of a flat glyph.
_WorldMapPlugin.HUMANOID_MODEL = "/Character models/main character.glb";
/** Hard cap on queued renders — prevents OOM when many objects become visible at once. */
_WorldMapPlugin.MAX_ICON_QUEUE = 40;
var WorldMapPlugin = _WorldMapPlugin;
export {
  WorldMapPlugin as default
};
