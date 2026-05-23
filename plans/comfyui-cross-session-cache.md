# Plan: ComfyUI Backend + Cross-Session Image Cache

## Overview

Two independent but small-scope additions to the Vistalyze extension:

1. **Problem 1 — ComfyUI Backend**: Add ComfyUI as a third image generation backend alongside Pollinations (cloud) and Local SD (ST extension). ComfyUI uses a **submit-then-poll** API pattern completely different from A1111/Local SD.

2. **Problem 2 — Cross-Session Image Cache**: When `handleKnownLocation()` finds no matching image for the current session's `vistalyze_{sessionId}_{key}.png`, search all server backgrounds for any `vistalyze_*_{key}.png` (any session) before regenerating.

---

## Problem 1: ComfyUI Backend

### Files Modified: 5

### 1A. [`defaults.js`](../../defaults.js)

- **Add** `export const DEFAULT_COMFYUI_PORT = 8188` after line 62
- **Update** comment on line 61 from `'pollinations' or 'localsd'` to `'pollinations', 'localsd', or 'comfyui'`

```js
/** Generation backend: 'pollinations' (default), 'localsd' (ST SD extension), or 'comfyui' (direct ComfyUI). */
export const DEFAULT_GENERATION_BACKEND = 'pollinations'

/** Default ComfyUI server port (for direct API calls). */
export const DEFAULT_COMFYUI_PORT = 8188
```

### 1B. [`settings/data.js`](../../settings/data.js)

**Import**: Add `DEFAULT_COMFYUI_PORT` to the imports from `../defaults.js` (line 40-46 area).

**PROFILE_DEFAULTS** (line 54-74): Add `comfyUiPort: DEFAULT_COMFYUI_PORT` after `generationBackend`:

```js
export const PROFILE_DEFAULTS = Object.freeze({
    // ... existing ...
    generationBackend:     DEFAULT_GENERATION_BACKEND,
    comfyUiPort:           DEFAULT_COMFYUI_PORT,
    devMode:               DEFAULT_DEV_MODE,
    // ... rest ...
});
```

### 1C. [`imageCache.js`](../../imageCache.js) — Primary Change

**Header Comment** (lines 1-23): Update the `@description` and `@contract` to document all three backends:

```js
/**
 * @description
 * Owns all image-related IO. Refactored to use the profile-aware getSettings() 
 * accessor for prompts, models, and dev mode flags.
 * 
 * Supports three generation backends:
 *   1. pollinations — cloud-based Pollinations API (default)
 *   2. localsd      — routes through ST's /api/sd/generate to any local SD extension backend
 *   3. comfyui      — direct ComfyUI submit-then-poll pattern via ComfyUI's native API
 */
```

**Import**: Add `DEFAULT_COMFYUI_PORT` to the imports from `./defaults.js` (around line 36).

**Add `generateViaComfyUI()` function** (after `generateViaLocalSD` at line 293):

Submit-then-poll pattern:
1. **Submit**: POST `http://localhost:{comfyUiPort}/prompt` with workflow JSON + `client_id`
2. **Poll**: GET `http://localhost:{comfyUiPort}/history/{prompt_id}` every 1500ms, up to 120s timeout
3. **Fetch**: GET `http://localhost:{comfyUiPort}/view?filename={output}&subfolder=&type=output`
4. **Upload**: Upload the blob to ST backgrounds store via `/api/backgrounds/upload`

```js
/**
 * Generates an image via direct ComfyUI API using a submit-then-poll pattern.
 * Uses the Z-Image Turbo workflow for fast generation.
 *
 * ComfyUI API flow:
 *   STEP 1 — POST /prompt (submit workflow JSON + client_id)
 *   STEP 2 — GET /history/<prompt_id> (poll until executed)
 *   STEP 3 — GET /view (fetch rendered image)
 *   STEP 4 — Upload to ST backgrounds store
 *
 * @param {string} finalPrompt The interpolated image prompt.
 * @param {string} filename The desired server filename.
 * @returns {Promise<string>} The uploaded filename on success.
 */
async function generateViaComfyUI(finalPrompt, filename) {
    const port = getSettings().comfyUiPort ?? DEFAULT_COMFYUI_PORT;
    const baseUrl = `http://localhost:${port}`;
    const clientId = crypto.randomUUID();
    
    log('ComfyUI', `Generating via direct ComfyUI at localhost:${port} ...`);
    
    // STEP 1: Build Z-Image Turbo workflow JSON
    const workflow = {
        "3": {
            "inputs": {
                "text": finalPrompt,
                "clip": ["11", 0]
            },
            "class_type": "CLIPTextEncode"
        },
        "6": {
            "inputs": {
                "text": "",
                "clip": ["11", 0]
            },
            "class_type": "CLIPTextEncode"
        },
        "8": {
            "inputs": {
                "samples": ["13", 0],
                "vae": ["10", 0]
            },
            "class_type": "VAEDecode"
        },
        "9": {
            "inputs": {
                "filename_prefix": "ComfyUI",
                "images": ["8", 0]
            },
            "class_type": "SaveImage"
        },
        "10": {
            "inputs": {
                "vae_name": "ae.safetensors"
            },
            "class_type": "VAELoader"
        },
        "11": {
            "inputs": {
                "unet_name": "z_image_turbo_bf16.safetensors"
            },
            "class_type": "UNETLoader"
        },
        "12": {
            "inputs": {
                "seed": Math.floor(Math.random() * 2147483647),
                "steps": 9,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1,
                "model": ["11", 0],
                "positive": ["3", 0],
                "negative": ["6", 0],
                "latent_image": ["13", 0]
            },
            "class_type": "KSampler"
        },
        "13": {
            "inputs": {
                "width": 1920,
                "height": 1080,
                "batch_size": 1
            },
            "class_type": "EmptyLatentImage"
        }
    };
    
    const promptPayload = {
        prompt: workflow,
        client_id: clientId
    };
    
    // STEP 1: Submit workflow
    log('ComfyUI', 'Submitting workflow...');
    let submitRes;
    try {
        submitRes = await fetch(`${baseUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(promptPayload),
        });
    } catch (err) {
        throw new Error(`ComfyUI connection failed at ${baseUrl} — is the server running? (${err.message})`);
    }
    
    if (!submitRes.ok) {
        const text = await submitRes.text();
        throw new Error(`ComfyUI /prompt error (${submitRes.status}): ${text}`);
    }
    
    const submitData = await submitRes.json();
    const promptId = submitData.prompt_id;
    
    log('ComfyUI', `Workflow submitted, prompt_id: ${promptId}`);
    
    // STEP 2: Poll /history/<prompt_id> until complete
    const pollInterval = 1500;   // 1.5 seconds
    const pollTimeout = 120000;  // 120 seconds
    let elapsed = 0;
    let outputs = null;
    
    while (elapsed < pollTimeout) {
        await new Promise(r => setTimeout(r, pollInterval));
        elapsed += pollInterval;
        
        const historyRes = await fetch(`${baseUrl}/history/${promptId}`);
        if (!historyRes.ok) continue;
        
        const historyData = await historyRes.json();
        const promptHistory = historyData[promptId];
        
        if (promptHistory && promptHistory.status?.completed) {
            outputs = promptHistory.outputs;
            log('ComfyUI', `Generation completed in ~${Math.round(elapsed / 1000)}s`);
            break;
        }
    }
    
    if (!outputs) {
        throw new Error(`ComfyUI generation timed out after ${pollTimeout / 1000}s`);
    }
    
    // STEP 3: Extract output filename from SaveImage node (node 9)
    const saveImageOutput = outputs?.["9"]?.images?.[0];
    if (!saveImageOutput) {
        throw new Error('ComfyUI completed but no image output found in SaveImage node');
    }
    
    const { filename: outputFilename, subfolder, type } = saveImageOutput;
    log('ComfyUI', `Output file: ${outputFilename} (subfolder: ${subfolder}, type: ${type})`);
    
    // STEP 3: Fetch the rendered image from /view
    const viewUrl = `${baseUrl}/view?filename=${encodeURIComponent(outputFilename)}&subfolder=${encodeURIComponent(subfolder ?? '')}&type=${encodeURIComponent(type ?? 'output')}`;
    
    const viewRes = await fetch(viewUrl);
    if (!viewRes.ok) {
        throw new Error(`ComfyUI /view error (${viewRes.status}): failed to fetch output image`);
    }
    
    const blob = await viewRes.blob();
    
    // STEP 4: Upload to ST backgrounds store
    const file = new File([blob], filename, { type: 'image/png' });
    const formData = new FormData();
    formData.append('avatar', file);
    
    const uploadRes = await fetch('/api/backgrounds/upload', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
    });
    
    if (!uploadRes.ok) {
        throw new Error(`Background upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
    }
    
    log('ComfyUI', `Image uploaded as "${filename}".`);
    return filename;
}
```

**Route in `generate()`** (around line 310-312, before the localsd branch):

```js
if (backend === 'comfyui') {
    return generateViaComfyUI(finalPrompt, filename)
}
```

### 1D. [`ui/settings/templates.js`](../../ui/settings/templates.js)

In the "Image Generation" section, line 195-201 (the backend dropdown):

**Add option** to the `<select id="lz-generation-backend">`:
```html
<option value="comfyui">ComfyUI (local)</option>
```

**Add ComfyUI port input** immediately after the dropdown (after the `</select>` closing tag on line 200), wrapped in a container that starts hidden:

```html
<div id="lz-comfyui-port-row" style="display:none;display:flex;align-items:center;gap:8px;margin-top:8px;">
    <label style="font-size:0.85em;opacity:0.75;white-space:nowrap;min-width:80px;" data-i18n="vistalyze.settings.label_comfyui_port">ComfyUI Port:</label>
    <input type="number" id="lz-comfyui-port" class="text_pole" min="1024" max="65535" step="1" style="width:100px;" />
    <span style="font-size:0.78em;opacity:0.55;">Default: 8188</span>
</div>
```

Note: `style="display:none;display:flex;..."` - the second `display:flex` is the JS-show state. Use CSS `display:flex` as target. The inline `display:none` takes precedence initially. JS toggles between `display:none` and `display:flex`.

Actually, better approach: use a class or just `display:none` initially and toggle with jQuery `.show()` / `.hide()`.

```html
<div id="lz-comfyui-port-row" style="display:none;margin-top:8px;display:flex;align-items:center;gap:8px;">
```

Wait, that's contradictory. Let me use just `display:none` initially:

```html
<div id="lz-comfyui-port-row" style="display:none;align-items:center;gap:8px;margin-top:8px;">
```

When shown via JS: `$('#lz-comfyui-port-row').css('display', 'flex')` or `.show()`.

### 1E. [`settings/panel.js`](../../settings/panel.js)

**Populate port input** in `populateInputs()` (after line 107 where backend dropdown is set):

```js
$('#lz-comfyui-port').val(s.comfyUiPort ?? DEFAULT_COMFYUI_PORT);
```

Need to import `DEFAULT_COMFYUI_PORT` from `../defaults.js`.

**Add change handler for port input** in `bindHandlers()` (after the backend change handler on line 248):

```js
$('#lz-settings').on('change', '#lz-comfyui-port', function () {
    const val = parseInt($(this).val()) || DEFAULT_COMFYUI_PORT;
    updateActiveSetting('comfyUiPort', val);
    updateDirtyIndicator(meta);
});
```

**Add show/hide logic** — show the port row when 'comfyui' is selected, hide otherwise. This can be done in two places:
1. In `populateInputs()` to set initial visibility
2. In the backend change handler to toggle on change

In `populateInputs()`:
```js
const showComfyPort = (s.generationBackend ?? 'pollinations') === 'comfyui';
$('#lz-comfyui-port-row').toggle(showComfyPort);
```

In the backend change handler (`#lz-generation-backend` change):
```js
$('#lz-comfyui-port-row').toggle($(this).val() === 'comfyui');
```

---

## Problem 2: Cross-Session Image Cache

### File Modified: 1

### 2A. [`logic/pipeline.js`](../../logic/pipeline.js)

**Add helper function** (top of file, after imports around line 41):

```js
/**
 * Searches state.allImages for any vistalyze_*_<key>.png filename
 * matching the given location key, regardless of session ID.
 * Returns the matched filename or null.
 */
function findCrossSessionImage(key, allImages) {
    if (!Array.isArray(allImages) || allImages.length === 0) return null;
    const suffix = `_${key}.png`;
    for (const f of allImages) {
        if (typeof f === 'string' && f.startsWith('vistalyze_') && f.endsWith(suffix)) {
            return f;
        }
    }
    return null;
}
```

**Modify `handleKnownLocation()`** — at line 175, between the `allImages.includes(filename)` check and the regenerate path, add a cross-session fallback step.

Current flow at lines 164-199:
```
line 168: if (state.allImages.includes(filename)) {
            // exact session match found outside index — use it
          } else { 
            // REGENERATE — not found anywhere
          }
```

New flow:
```
line 168: if (state.allImages.includes(filename)) {
            // exact session match found outside index — use it
          } else {
            // CROSS-SESSION FALLBACK: search for vistalyze_*_<key>.png
            const crossSessionFile = findCrossSessionImage(key, state.allImages);
            if (crossSessionFile) {
              // Found from another session — use it
            } else {
              // REGENERATE — not found at all
            }
          }
```

The cross-session branch should:
- Log the find: `Found cross-session image "${crossSessionFile}" for key "${key}".`
- Add to fileIndex: `addToFileIndex(crossSessionFile)`
- Set background: `setBg(crossSessionFile)`
- Write scene record with `image: crossSessionFile`
- Update state with `crossSessionFile`

This mirrors the exact-session branch (lines 169-174) but uses the cross-session filename.

---

## Explicit Scope Boundaries

The following MUST NOT be changed:
- Pollinations backend logic
- LocalSD backend logic
- LLM call logic (detector.js, prompt building)
- State management outside allImages/setAllImages
- Bootstrapper logic
- Maintenance/delete logic
- Workshop/UI logic outside settings templates/panel
- I18n files (translations)
- Any CSS or styling beyond inline styles in templates

---

## Implementation Order

1. [`defaults.js`](../../defaults.js) — Add `DEFAULT_COMFYUI_PORT` constant
2. [`settings/data.js`](../../settings/data.js) — Import and add to `PROFILE_DEFAULTS`
3. [`imageCache.js`](../../imageCache.js) — Add `generateViaComfyUI()`, import port constant, route in `generate()`, update header
4. [`ui/settings/templates.js`](../../ui/settings/templates.js) — Add dropdown option + port input
5. [`settings/panel.js`](../../settings/panel.js) — Bind port input, show/hide logic, populate
6. [`logic/pipeline.js`](../../logic/pipeline.js) — Add `findCrossSessionImage()` + fallback logic
