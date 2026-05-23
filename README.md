Personal fork of Vistalyze to change some structural functions to my preferences. Please support the official [Vistalyze](https://github.com/ZapoVerde/SillyTavern-Vistalyze)

---

# Vistalyze Fork — Changelog
**Upstream:** [ZapoVerde/SillyTavern-Vistalyze](https://github.com/ZapoVerde/SillyTavern-Vistalyze)  
**Fork purpose:** Local image generation via ComfyUI + cross-session image caching fixes

---

## Files Removed from Upstream

These files exist in the upstream repo but were removed in this fork:

- **`logic/importController.js`** — handles importing location libraries from other chats
- **`ui/bgHijacker.js`** — overrides ST's native background controls
- **`ui/importModal.js`** + **`ui/import/`** — UI for the import workflow

These features (cross-chat library import, custom background hijacking) are not present in this fork.

---

## Files Added in Fork

- **`plans/comfyui-cross-session-cache.md`** — planning document for the ComfyUI and caching changes
- **`bugs/`** — bug tracking folder

---

## imageCache.js — Major Changes

### New: ComfyUI generation backend
The original only supported Pollinations. The fork adds two new backends selectable via settings:

**`comfyui`** — Direct browser-to-ComfyUI API calls using the submit-then-poll pattern:
1. POST workflow JSON to `http://127.0.0.1:<port>/prompt`
2. Poll `GET /history/<prompt_id>` every 1500ms until complete (120s timeout)
3. Extract image info from outputs
4. Fetch rendered image binary from `GET /view`
5. Upload blob to ST backgrounds store

Uses a Z-Image Turbo workflow exported directly from ComfyUI in API format with the correct node architecture:
- `CLIPLoader` with `type: "lumina2"` (not generic CLIPTextEncode)
- `EmptySD3LatentImage` (not EmptyLatentImage)
- `ModelSamplingAuraFlow` with `shift: 3`
- `ConditioningZeroOut` for negative conditioning
- `res_multistep` sampler + `simple` scheduler, 8 steps, CFG 1.0
- `ae.safetensors` VAE
- 1920x1080 output resolution

CORS is handled at the ComfyUI level via the `--enable-cors-header *` launch flag — no ST proxy required.

**`localsd`** — Routes through ST's `/api/sd/generate` endpoint (A1111 or any ST SD extension backend). Handles both direct image responses and base64 JSON responses.

Both new backends also have a blob-only preview variant (`generateViaComfyUIBlob`, `generateViaLocalSDBlob`) used by the workshop's thumbnail preview without uploading to the server.

### New: `verifyImage(filename)`
Before serving a cached file, loads it into an in-memory `<img>` element with a 10-second timeout to confirm it's not corrupt or zero-dimension. Corrupt files are flagged for regeneration. The upstream had no corruption detection.

### Changed: `fetchFullBlob()` is now backend-aware
The original `fetchFullBlob()` always used Pollinations. The fork routes it through whichever backend is configured.

### Changed: `fetchFileIndex()` normalization
The original used: `f => (typeof f === 'string' ? f : f.filename)`

The fork expands this with explicit null-safety (`f?.filename ?? ''`) and adds a comment block explaining the normalization, since ST's `/api/backgrounds/all` returns `{ filename, isAnimated }` objects. The fork also returns a plain array `allImages` (not a Set) to support pattern-based cross-session matching.

### Changed: `generate()` routing
Now checks `generationBackend` setting and routes to `generateViaComfyUI()`, `generateViaLocalSD()`, or Pollinations accordingly.

---

## state.js — Changes

### Removed: `allFileIndex` (Set) — Replaced with `allImages` (Array) + `addToAllImages()`

The upstream uses `allFileIndex: new Set()` — a Set of all vistalyze filenames across sessions, populated once at boot and never updated during a session.

The fork replaces this with:
- `allImages: []` — a plain Array of all server background filenames (unfiltered, not just vistalyze files)
- `setAllImages(images)` — overwrites on boot
- `addToAllImages(filename)` — appends a single filename after each successful generation

The Array format is required because `findCrossSessionImage()` uses `startsWith`/`endsWith` pattern matching rather than exact key lookups. `addToAllImages()` ensures newly generated files are immediately findable by cross-session lookups within the same session, without waiting for the next boot.

### Removed: `sourceSessionId` and `customBg` location fields

The upstream tracks two special location types:
- `customBg` — a location pinned to a specific user-chosen background image
- `sourceSessionId` — a location "borrowed" from another chat, with its asset living under the source session's namespace

The fork removes both concepts. All locations generate fresh assets under the current session.

### Removed: `_importCache`

Tracked temporary data for the cross-chat import feature. Removed along with the import feature.

---

## logic/pipeline.js — Changes

### New: `findCrossSessionImage(key, allImages)`
Before calling `generate()`, searches `allImages` for any file matching `vistalyze_*_<key>.png` regardless of sessionId. If found, serves the existing file instead of generating a new one. Called in three places:
1. `handleKnownLocation()` — when a file isn't found by exact match
2. `handleUnknownLocation()` — before first-time generation of a newly approved location
3. Boot sequence (via `bootstrapper.js`) — on startup before targeted regeneration

### New: Image corruption detection in `handleKnownLocation()`
When a file is found in `fileIndex`, calls `verifyImage()` before applying it. If corrupt, regenerates automatically. The upstream had no corruption detection.

### Changed: `handleKnownLocation()` cache lookup chain
The upstream checked `state.allFileIndex.has(filename)` (one check), then regenerated if missing.

The fork uses a three-step lookup:
1. Check `state.fileIndex` (current session) → verify → apply
2. Check `state.allImages.includes(filename)` (exact match, full server list)
3. `findCrossSessionImage()` (pattern match across all sessions)
4. Only if all three miss → regenerate

### Changed: `addToAllImages()` called after every generation
After every successful `generate()` call, the fork calls both `addToFileIndex(newFile)` and `addToAllImages(newFile)`. The upstream only called `addToFileIndex()`. Without this, subsequent same-session visits would miss the cross-session lookup and regenerate unnecessarily.

### Changed: Cancelled location discovery preserves current background
The upstream called `clearBg()` and nulled state if a new location discovery was cancelled or failed. The fork preserves the current background on cancellation.

---

## logic/bootstrapper.js — Changes

### Removed: Bulk self-healing regeneration queue

The upstream boot sequence queues every location in the library whose image is missing and regenerates all of them at boot. It has special handling for `sourceSessionId` (borrowed assets) and `customBg` (pinned backgrounds).

The fork removes the bulk queue entirely. Boot now only attempts to restore the **current scene's** image. All other locations are regenerated on-demand by the pipeline when visited. This prevents intentionally deleted files from reappearing on every boot.

### Changed: `isImageMissing` check extended to `allImages`

Upstream: `!state.fileIndex.has(currentImage)`

Fork: `!state.fileIndex.has(expectedFilename) && !state.allImages.includes(expectedFilename)`

This prevents triggering regeneration when the file exists on the server under the current sessionId but outside the session-scoped `fileIndex`.

### Changed: Cross-session fallback at boot

After the `isImageMissing` check, the fork calls `findCrossSessionImage()` before regenerating. If any `vistalyze_*_<key>.png` exists for the current location's key, it's used directly and patched into the DNA.

### Changed: `addToAllImages()` called after boot regeneration

When boot does trigger a targeted regeneration, `addToAllImages(newFile)` is called alongside `addToFileIndex(newFile)`.

### Changed: State imports

Upstream imported `setAllFileIndex`. Fork imports `setAllImages`, `addToAllImages`, `updateState`, and `findCrossSessionImage` (from pipeline.js).

---

## defaults.js — Changes

### Added: Two new constants
```js
export const DEFAULT_GENERATION_BACKEND = 'pollinations'
export const DEFAULT_COMFYUI_PORT = 8188
```

### Changed: Dev mode image dimensions
- Upstream: `DEV_IMAGE_WIDTH = 320`, `DEV_IMAGE_HEIGHT = 180`
- Fork: `DEV_IMAGE_WIDTH = 456`, `DEV_IMAGE_HEIGHT = 256`

---

## settings/data.js — Changes

### Added: Two new profile defaults
```js
generationBackend: DEFAULT_GENERATION_BACKEND,  // 'pollinations' | 'localsd' | 'comfyui'
comfyUiPort:       DEFAULT_COMFYUI_PORT,         // 8188
```

---

## ui/settings/templates.js — Changes

### Added: Backend selector and ComfyUI port field
New UI under Image Generation settings:
- Dropdown: Pollinations (default) / Local SD (ST extension) / ComfyUI (local)
- ComfyUI port number input (hidden unless ComfyUI is selected, default 8188, range 1024–65535)

---

## logic/commit.js — Changes

### Removed: `customBg` and `sourceSessionId` branching

The upstream `handleFinalizeWorkshop()` branches across three asset cases: `customBg` (pinned background), `sourceSessionId` (borrowed asset), and normal generation. The fork removes both special cases — all commits generate under the current session.

---

## Summary Table

| Area | Upstream | Fork |
|---|---|---|
| Image backends | Pollinations only | Pollinations + LocalSD + ComfyUI |
| ComfyUI workflow | — | Z-Image Turbo (API format, correct node graph) |
| Cross-session image reuse | `allFileIndex` Set, exact match only | `allImages` Array + `findCrossSessionImage()` pattern match |
| `allImages` updated after generation | No | Yes (`addToAllImages()`) |
| Image corruption detection | No | Yes (`verifyImage()` before applying cached files) |
| Boot regeneration | Bulk queue — all missing locations | Current scene only; others on-demand |
| `customBg` / `sourceSessionId` support | Yes | Removed |
| Cross-chat import feature | Yes | Removed |
| `bgHijacker.js` | Yes | Removed |
| Dev image dimensions | 320x180 | 456x256 |
