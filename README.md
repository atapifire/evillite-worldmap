# EvilLite — World Map plugin

A filterable, searchable top-down **world map** for [EvilQuest](https://evilquest.net),
built as a plugin for the [EvilLite](https://github.com/atapifire/EvilLite) client.

It renders entirely from **live in-game data** (no extra assets or servers): the
game's own minimap colours for terrain/water, and the live object/NPC/player data
for markers. As you explore, the map fills in and persists per-map.

<!-- TODO: add a screenshot of the world map in action -->

## Features

- **Terrain & water** — replicates the game's minimap colour logic (grass, water,
  dirt, sand, stone, walls, roofs, textured tiles), accumulated across the whole
  explored map and persisted so it stays filled even where chunks have unloaded.
- **Object markers** — every placed object, colour/shape-coded by the game's own
  category (`tree`, `rock`, `bank`, `furnace`, `cookingrange`, `fishingspot`,
  `crop`, `chest`, `door`, `ladder`, …). Depleted nodes are dimmed.
- **NPCs** — shown live (with combat level), plus an accumulating, persisted
  "sightings" heatmap of where each NPC type has been seen.
- **Players** — other players shown live.
- **Filter panel** — auto-built from whatever categories/subtypes exist in the
  data (so new EvilQuest content appears automatically), with per-category and
  per-subtype checkboxes.
- **Search + jump** — type a name and jump to the nearest match.
- **Hover tooltips & click-to-centre.** Opens with the **M** key.

Everything is accessed through stable *semantic* property names on the live
`GameManager` (`window.gm`), so it keeps working across EvilQuest updates.

## Why this is its own repo

EvilLite plugins live in their own repositories rather than in the client repo.
The client loads them as standalone ES-module bundles, and (per the planned
plugin hub) an approval/distribution site references each plugin by URL + hash.
This repo is a reference example of that structure:

```
src/WorldMapPlugin.ts   the plugin (extends `Plugin` from @evillite/core)
dist/world-map.js       built ES-module bundle the client loads
data/world-map-icons.json  prebaked model-icon cache (loaded via the core
                        PluginAssetCache; copied into the client's plugins/data/)
plugin.json             manifest (id, author, version, entry, sha256) for the hub
package.json            build via esbuild; @evillite/core + @babylonjs are externals
```

Persistence & assets use core services: per-map object/NPC/filter state is stored
on the reactive `plugin.data` (auto-persisted to IndexedDB per user), and rendered
model icons are cached via core's `PluginAssetCache` (the prebaked `data/` file
above, so end users load icons instead of regenerating them).

The plugin imports from `@evillite/core`, which the client provides at runtime via
its import map — so the bundle stays tiny and never vendors the core.

## Build

```bash
yarn          # or npm install
yarn build    # -> dist/world-map.js
```

`@evillite/core` and `@babylonjs/*` are marked external; they are supplied by the
EvilLite client at runtime.

## Use it in the client

**Dev (today):** drop the built `dist/world-map.js` (or `src/WorldMapPlugin.ts`)
into the client's local `packages/client/src/renderer/client/plugins/` folder —
that folder is gitignored and auto-loaded, so it's the current dev-plugin path.

**Future (plugin hub):** the client fetches approved plugins from the hub by URL,
verifies `sha256`, and loads the bundle dynamically. `plugin.json` is the manifest
entry for that flow.

## License

GPL-3.0-only, matching EvilLite.
