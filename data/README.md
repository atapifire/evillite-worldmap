# Prebaked icon cache

`world-map-icons.json` holds the World Map's prebaked object/NPC icons
(`key -> PNG data URL`). The EvilLite client bundles this at build time so users load
icons instead of regenerating them at runtime. CI pulls this file (and the plugin)
from this repo when building.

## ⚠️ This cache is incomplete until the whole map has been explored
The plugin renders an icon the **first time it encounters that model in-world**, so
the cache only covers areas that have actually been walked. It currently has ~95 icons
— the game has more.

### To complete it
1. Run a **dev** client (`yarn dev` in the EvilLite repo — dev builds write new icons
   to the source-tree cache; packaged builds are read-only).
2. Walk the **entire map** — every region and floor — so each object/NPC model loads
   and gets rendered. (The plugin already tries to render every object it sees, not
   just visible markers, so coverage = wherever you've been.)
3. The new icons accumulate in
   `EvilLite/packages/client/src/renderer/client/plugins/data/world-map-icons.json`.
4. Copy that file back here (`data/world-map-icons.json`) and commit, so the next CI
   build ships the fuller set.

### Faster alternative (worth building)
A dev "render-all" pass that iterates every model file from the object/NPC definition
tables and renders them up front — no walking required. Tracked in the EvilLite repo's
`DISTRIBUTION-TODO.md` (item 2b).
