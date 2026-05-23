/**
 * @file imageCache.js
 * @stamp {"utc":"2026-03-30T00:00:00.000Z"}
 * @architectural-role Image IO
 * @description
 * Owns all image-related IO. Refactored to use the profile-aware getSettings()
 * accessor for prompts, models, and dev mode flags.
 *
 * Supports three generation backends:
 *   1. pollinations (default) — cloud-based Pollinations API
 *   2. localsd               — routes through ST's /api/sd/generate to any local SD extension backend
 *   3. comfyui               — direct browser-to-ComfyUI calls (CORS handled via --enable-cors-header *)
 *
 * @updates
 * - Migrated from direct extension_settings access to getSettings().
 * - Standardized usage of profile-level configuration.
 * - Added generateViaComfyUI() — direct browser-to-ComfyUI submit-then-poll pattern.
 * - Added 'comfyui' routing branch in generate().
 *
 * @api-declaration
 * fetchPreviewBlob(prompt) → Promise<string> (Object URL)
 * fetchFileIndex(sessionId) → Promise<{fileIndex, allImages}>
 * generate(key, locationDef, sessionId) → Promise<string> (filename)
 * generateViaComfyUI(finalPrompt, filename) → Promise<string> (internal)
 *
 * @contract
 *   assertions:
 *     purity: IO
 *     state_ownership: []
 *     external_io: [findSecret, fetch(/api/backgrounds/all), fetch(/api/backgrounds/upload), fetch(http://127.0.0.1:<port>/prompt), fetch(http://127.0.0.1:<port>/history/), fetch(http://127.0.0.1:<port>/view)]
 */

import { getRequestHeaders } from '../../../../script.js'
import { findSecret } from '../../../secrets.js'
import { getSettings } from './settings/data.js'
import { log, warn, error } from './utils/logger.js'
import {
    POLLINATIONS_BASE_URL,
    POLLINATIONS_APP_KEY,
    DEFAULT_IMAGE_MODEL,
    DEFAULT_IMAGE_PROMPT_TEMPLATE,
    DEFAULT_COMFYUI_PORT,
    DEV_IMAGE_WIDTH,
    DEV_IMAGE_HEIGHT,
} from './defaults.js'

/** Standard SillyTavern secret key name for Pollinations */
const SECRET_KEY_NAME = 'api_key_pollinations'

function interpolateImagePrompt(template, locationDef) {
    return template
        .replace(/\{\{image_prompt\}\}/g, locationDef.imagePrompt ?? '')
        .replace(/\{\{name\}\}/g,         locationDef.name        ?? '')
        .replace(/\{\{description\}\}/g,  locationDef.description ?? '')
}

function buildPollinationsUrl(finalPrompt, overrides = {}) {
    const s = getSettings()
    const devMode = s.devMode ?? false
    const params = new URLSearchParams({
        width:  overrides.width  ?? (devMode ? String(DEV_IMAGE_WIDTH)  : '1920'),
        height: overrides.height ?? (devMode ? String(DEV_IMAGE_HEIGHT) : '1080'),
        model:    s.imageModel ?? DEFAULT_IMAGE_MODEL,
        nologo:   'true',
        referrer: POLLINATIONS_APP_KEY,
    })
    return `${POLLINATIONS_BASE_URL}/image/${encodeURIComponent(finalPrompt)}?${params.toString()}`
}

/**
 * Retrieves the API key using the standard ST findSecret function.
 */
async function getAuthHeaders() {
    const userKey = await findSecret(SECRET_KEY_NAME)
    
    if (!userKey) {
        throw new Error(
            'Pollinations API key not found or blocked.\n\n' +
            '1. Ensure the key is set in ST API settings (Pollinations).\n' +
            '2. In SillyTavern/config.yaml, set "allowKeysExposure: true" then restart the server.'
        )
    }
    
    return {
        'Authorization': `Bearer ${userKey}`,
    }
}

async function validateImageResponse(response) {
    if (!response.ok) {
        const text = await response.text()
        throw new Error(`Pollinations API Error (${response.status}): ${text}`)
    }
    const contentType = response.headers.get('Content-Type')
    if (!contentType || !contentType.startsWith('image/')) {
        const text = await response.text()
        throw new Error(`Expected image, but received ${contentType}: ${text}`)
    }
}

export async function fetchPreviewBlob(prompt) {
    const url = buildPollinationsUrl(prompt, { width: String(DEV_IMAGE_WIDTH), height: String(DEV_IMAGE_HEIGHT) })
    const headers = await getAuthHeaders()

    const res = await fetch(url, { headers })
    await validateImageResponse(res)

    return URL.createObjectURL(await res.blob())
}

/**
 * Fetches a full-resolution image using the configured backend (Pollinations,
 * ComfyUI, or LocalSD), returning a local blob URL for preview display.
 * Unlike generate(), this does NOT upload to the ST backgrounds store —
 * the filename is assigned later, at upload time.
 */
export async function fetchFullBlob(locationDef) {
    const template = getSettings().imagePromptTemplate ?? DEFAULT_IMAGE_PROMPT_TEMPLATE
    const finalPrompt = interpolateImagePrompt(template, locationDef)
    const backend = getSettings().generationBackend ?? 'pollinations'

    if (backend === 'comfyui') {
        // Use ComfyUI — run steps 1-4 (submit, poll, fetch) but skip upload.
        // Returns a blob: URL for preview display.
        const blob = await generateViaComfyUIBlob(finalPrompt);
        return URL.createObjectURL(blob);
    }

    if (backend === 'localsd') {
        // Use LocalSD — generate image via ST SD endpoint, return blob URL.
        const blob = await generateViaLocalSDBlob(finalPrompt);
        return URL.createObjectURL(blob);
    }

    // Default: Pollinations
    const url = buildPollinationsUrl(finalPrompt)
    const headers = await getAuthHeaders()

    const res = await fetch(url, { headers })
    await validateImageResponse(res)

    return URL.createObjectURL(await res.blob())
}

/**
 * Uploads a pre-fetched blob URL to the server backgrounds store.
 * Filename is assigned here — this is the "write" step.
 */
export async function uploadBlob(blobUrl, filename) {
    const res = await fetch(blobUrl)
    const blob = await res.blob()
    const file = new File([blob], filename, { type: 'image/png' })

    const formData = new FormData()
    formData.append('avatar', file)

    const uploadRes = await fetch('/api/backgrounds/upload', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
    })

    if (!uploadRes.ok) throw new Error(`Background upload failed: ${uploadRes.status} ${uploadRes.statusText}`)

    return filename
}

export async function fetchFileIndex(sessionId) {
    const res = await fetch('/api/backgrounds/all', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    })
    const data = await res.json()
    const images = data.images ?? []
    // Normalize: SillyTavern's /api/backgrounds/all may return objects
    // (e.g. {name: "file.png"}) instead of plain filename strings.
    // Extract the string representation safely to prevent
    // "f.startsWith is not a function" errors downstream.
    const normalizedImages = images.map(f =>
        typeof f === 'string' ? f : (f?.filename ?? '')
    )
    const fileIndex = new Set(normalizedImages.filter(f => f.startsWith(`vistalyze_${sessionId}_`)))
    return { fileIndex, allImages: normalizedImages }
}

/**
 * Verifies that a background image file exists on the server and is a valid,
 * loadable image. Uses an in-memory Image element with a timeout.
 *
 * This is used by the pipeline to detect corrupt or broken image files
 * that exist in the file index but cannot actually be displayed.
 *
 * @param {string} filename - The background filename to verify.
 * @returns {Promise<boolean>} - True if the image loads successfully.
 */
export function verifyImage(filename) {
    return new Promise((resolve) => {
        const timeoutMs = 10000; // 10 second timeout
        
        // Construct the same URL pattern used by background.js for consistency
        const url = `backgrounds/${encodeURIComponent(filename)}?v=${Date.now()}`;
        
        const img = new Image();
        let settled = false;
        
        const finish = (valid) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(valid);
        };
        
        const timer = setTimeout(() => {
            console.warn(`[Vistalyze] Image verification timed out for: ${filename}`);
            finish(false);
        }, timeoutMs);
        
        img.onload = () => {
            // Image loaded successfully — verify it has non-zero dimensions
            const valid = img.naturalWidth > 0 && img.naturalHeight > 0;
            if (!valid) {
                console.warn(`[Vistalyze] Image verification failed: ${filename} has zero dimensions (corrupt).`);
            }
            finish(valid);
        };
        
        img.onerror = () => {
            console.warn(`[Vistalyze] Image verification failed: ${filename} could not be loaded (corrupt or missing).`);
            finish(false);
        };
        
        img.src = url;
    });
}

/**
 * Converts a base64 data URL to a Blob.
 * @param {string} dataUrl e.g. "data:image/png;base64,..."
 * @returns {Promise<Blob>}
 */
async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl)
    return res.blob()
}

/**
 * Generates an image via ST's SD endpoint and returns the raw Blob.
 * Used by fetchFullBlob() for preview display — does NOT upload to ST.
 *
 * @param {string} finalPrompt The interpolated image prompt.
 * @returns {Promise<Blob>} The rendered image blob.
 */
async function generateViaLocalSDBlob(finalPrompt) {
    log('LocalSD', `Generating preview blob via ST SD extension: "${finalPrompt.substring(0, 60)}..."`);

    const res = await fetch('/api/sd/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt: finalPrompt,
            width: 512,
            height: 512,
            steps: 20,
        }),
    });

    if (!res.ok) {
        throw new Error(`Local SD API error (${res.status}): ${res.statusText}`);
    }

    const contentType = res.headers.get('Content-Type') || '';

    let blob;
    if (contentType.startsWith('image/')) {
        blob = await res.blob();
        log('LocalSD', 'Received direct image blob from SD endpoint.');
    } else {
        const data = await res.json();
        const imageData = data.image || data.images?.[0];

        if (!imageData) {
            throw new Error('Local SD returned no image data in response.');
        }

        if (typeof imageData === 'string' && imageData.startsWith('data:')) {
            blob = await dataUrlToBlob(imageData);
        } else if (typeof imageData === 'string') {
            blob = await dataUrlToBlob(`data:image/png;base64,${imageData}`);
        } else {
            throw new Error('Local SD returned unrecognized image format.');
        }
        log('LocalSD', 'Extracted image from JSON response.');
    }

    log('LocalSD', `Rendered image fetched (${blob.size} bytes). Returning blob for preview.`);
    return blob;
}

/**
 * Generates an image via SillyTavern's built-in Stable Diffusion API endpoint.
 * This routes through whatever backend the user has configured in the SD extension
 * (Auto1111, ComfyUI, Drawthings, etc.).
 *
 * @param {string} finalPrompt The interpolated image prompt.
 * @param {string} filename The desired server filename.
 * @returns {Promise<string>} The uploaded filename on success.
 */
async function generateViaLocalSD(finalPrompt, filename) {
    log('LocalSD', `Generating via ST SD extension: "${finalPrompt.substring(0, 60)}..."`);

    const res = await fetch('/api/sd/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt: finalPrompt,
            width: 512,
            height: 512,
            steps: 20,
        }),
    });

    if (!res.ok) {
        throw new Error(`Local SD API error (${res.status}): ${res.statusText}`);
    }

    // Determine response type
    const contentType = res.headers.get('Content-Type') || '';

    let blob;
    if (contentType.startsWith('image/')) {
        // Direct image response
        blob = await res.blob();
        log('LocalSD', 'Received direct image blob from SD endpoint.');
    } else {
        // JSON response — extract image from data field
        const data = await res.json();
        const imageData = data.image || data.images?.[0];

        if (!imageData) {
            throw new Error('Local SD returned no image data in response.');
        }

        // Handle both full data URLs and raw base64
        if (typeof imageData === 'string' && imageData.startsWith('data:')) {
            blob = await dataUrlToBlob(imageData);
        } else if (typeof imageData === 'string') {
            blob = await dataUrlToBlob(`data:image/png;base64,${imageData}`);
        } else {
            throw new Error('Local SD returned unrecognized image format.');
        }
        log('LocalSD', 'Extracted image from JSON response.');
    }

    // Upload the blob to ST backgrounds store
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

    log('LocalSD', `Image uploaded as "${filename}".`);
    return filename;
}

/**
 * Generates an image via ComfyUI (steps 1-4 only) and returns the raw Blob.
 * Used by fetchFullBlob() for preview display — does NOT upload to ST.
 *
 * Pattern: submit-then-poll
 *   1. POST /prompt  →  receives { prompt_id }
 *   2. GET  /history/<prompt_id>  →  poll every 1500ms until outputs appear
 *   3. GET  /view?filename=...  →  fetch rendered image binary
 *   4. Return Blob
 *
 * @param {string} finalPrompt The interpolated image prompt.
 * @returns {Promise<Blob>} The rendered image blob.
 */
async function generateViaComfyUIBlob(finalPrompt) {
    const port = getSettings().comfyUiPort ?? DEFAULT_COMFYUI_PORT;
    const baseUrl = `http://127.0.0.1:${port}`;
    const clientId = Math.random().toString(36).substring(2);

    log('ComfyUI', `Generating preview blob via direct browser call (${baseUrl}) ...`);

    // ── Build Z-Image Turbo workflow JSON ──────────────────────────────────
    const workflow = {
        "9": {
            "inputs": {
                "filename_prefix": "z-image-turbo",
                "images": ["57:8", 0]
            },
            "class_type": "SaveImage"
        },
        "57:30": {
            "inputs": {
                "clip_name": "qwen_3_4b.safetensors",
                "type": "lumina2",
                "device": "default"
            },
            "class_type": "CLIPLoader"
        },
        "57:29": {
            "inputs": {
                "vae_name": "ae.safetensors"
            },
            "class_type": "VAELoader"
        },
        "57:33": {
            "inputs": {
                "conditioning": ["57:27", 0]
            },
            "class_type": "ConditioningZeroOut"
        },
        "57:8": {
            "inputs": {
                "samples": ["57:3", 0],
                "vae": ["57:29", 0]
            },
            "class_type": "VAEDecode"
        },
        "57:28": {
            "inputs": {
                "unet_name": "z_image_turbo_bf16.safetensors",
                "weight_dtype": "default"
            },
            "class_type": "UNETLoader"
        },
        "57:27": {
            "inputs": {
                "text": finalPrompt,
                "clip": ["57:30", 0]
            },
            "class_type": "CLIPTextEncode"
        },
        "57:13": {
            "inputs": {
                "width": 1920,
                "height": 1080,
                "batch_size": 1
            },
            "class_type": "EmptySD3LatentImage"
        },
        "57:11": {
            "inputs": {
                "shift": 3,
                "model": ["57:28", 0]
            },
            "class_type": "ModelSamplingAuraFlow"
        },
        "57:3": {
            "inputs": {
                "seed": Math.floor(Math.random() * 2147483647),
                "steps": 8,
                "cfg": 1,
                "sampler_name": "res_multistep",
                "scheduler": "simple",
                "denoise": 1,
                "model": ["57:11", 0],
                "positive": ["57:27", 0],
                "negative": ["57:33", 0],
                "latent_image": ["57:13", 0]
            },
            "class_type": "KSampler"
        }
    };

    // ── STEP 1: Submit workflow to ComfyUI ───────────────────────────────────
    log('ComfyUI', 'STEP 1 — Submitting prompt to ComfyUI...');
    let promptRes;
    try {
        promptRes = await fetch(`${baseUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        });
    } catch (err) {
        throw new Error(`ComfyUI connection failed — is ComfyUI running at ${baseUrl}? (${err.message})`);
    }

    if (!promptRes.ok) {
        const text = await promptRes.text();
        throw new Error(`ComfyUI /prompt error (${promptRes.status}): ${text}`);
    }

    const { prompt_id } = await promptRes.json();
    if (!prompt_id) {
        throw new Error('ComfyUI did not return a prompt_id.');
    }
    log('ComfyUI', `Prompt submitted, prompt_id: ${prompt_id}`);

    // ── STEP 2: Poll /history/<prompt_id> until job completes ────────────────
    log('ComfyUI', 'STEP 2 — Polling /history for completion...');
    const pollIntervalMs = 1500;
    const pollTimeoutMs = 120000;
    const startTime = Date.now();
    let historyData = null;

    while (Date.now() - startTime < pollTimeoutMs) {
        await new Promise(r => setTimeout(r, pollIntervalMs));

        let historyRes;
        try {
            historyRes = await fetch(`${baseUrl}/history/${prompt_id}`);
        } catch {
            continue;
        }

        if (!historyRes.ok) continue;

        historyData = await historyRes.json();

        if (historyData && historyData[prompt_id]) {
            const item = historyData[prompt_id];
            if (item.status?.status_str === 'error') {
                const errorMessages = item.status?.messages
                    ?.filter(m => m[0] === 'execution_error')
                    ?.map(m => m[1])
                    ?.map(m => `${m.node_type} [${m.node_id}] ${m.exception_type}: ${m.exception_message}`)
                    ?.join('\n') || 'Unknown ComfyUI execution error';
                throw new Error(`ComfyUI generation failed:\n${errorMessages}`);
            }
            if (item.outputs && Object.keys(item.outputs).length > 0) {
                log('ComfyUI', 'Job completed.');
                break;
            }
        }

        log('ComfyUI', 'Still waiting...');
        historyData = null;
    }

    if (!historyData || !historyData[prompt_id]) {
        throw new Error(`ComfyUI generation timed out after ${pollTimeoutMs / 1000}s.`);
    }

    // ── STEP 3: Extract image metadata from outputs ─────────────────────────
    log('ComfyUI', 'STEP 3 — Extracting image metadata from outputs...');
    const outputs = historyData[prompt_id].outputs;
    const allImages = Object.values(outputs)
        .flatMap(o => o.images || o.gifs || []);
    const imgInfo = allImages[0];

    if (!imgInfo) {
        throw new Error('ComfyUI completed but no images found in outputs.');
    }

    const { filename: imgFilename, subfolder, type } = imgInfo;
    log('ComfyUI', `Image found: ${imgFilename} (subfolder="${subfolder}", type="${type}")`);

    // ── STEP 4: Fetch the rendered image binary ─────────────────────────────
    log('ComfyUI', 'STEP 4 — Fetching rendered image...');
    const viewUrl = new URL(`${baseUrl}/view`);
    viewUrl.searchParams.set('filename', imgFilename);
    viewUrl.searchParams.set('subfolder', subfolder || '');
    viewUrl.searchParams.set('type', type || 'output');

    let viewRes;
    try {
        viewRes = await fetch(viewUrl.toString());
    } catch (err) {
        throw new Error(`ComfyUI /view connection failed: ${err.message}`);
    }

    if (!viewRes.ok) {
        const text = await viewRes.text();
        throw new Error(`ComfyUI /view error (${viewRes.status}): ${text}`);
    }

    const blob = await viewRes.blob();
    log('ComfyUI', `Rendered image fetched (${blob.size} bytes). Returning blob for preview.`);
    return blob;
}

/**
 * Generates an image via ComfyUI using direct browser-to-ComfyUI calls.
 * CORS is handled at the ComfyUI level via the --enable-cors-header * launch flag.
 *
 * Uses the submit-then-poll pattern:
 *   STEP 1 — POST /prompt with workflow JSON + client_id
 *   STEP 2 — Poll GET /history/<prompt_id> every 1500ms until done (120s timeout)
 *   STEP 3 — Extract image info from outputs { filename, subfolder, type }
 *   STEP 4 — Fetch rendered image via GET /view
 *   STEP 5 — Upload blob to ST backgrounds store
 *
 * @param {string} finalPrompt The interpolated image prompt.
 * @param {string} filename The desired server filename.
 * @returns {Promise<string>} The uploaded filename on success.
 */
async function generateViaComfyUI(finalPrompt, filename) {
    const port = getSettings().comfyUiPort ?? DEFAULT_COMFYUI_PORT;
    const baseUrl = `http://127.0.0.1:${port}`;
    const clientId = Math.random().toString(36).substring(2);

    log('ComfyUI', `Generating via direct browser call (${baseUrl}) ...`);

    // ── Build Z-Image Turbo workflow JSON ──────────────────────────────────
    // Z-Image Turbo workflow — exported from ComfyUI in API format.
    // Uses the correct node types for this architecture:
    //   - CLIPLoader (lumina2 type) instead of generic CLIPTextEncode+CLIP
    //   - EmptySD3LatentImage instead of EmptyLatentImage
    //   - ModelSamplingAuraFlow (shift:3) wrapper before KSampler
    //   - ConditioningZeroOut for negative instead of empty text
    //   - res_multistep sampler + simple scheduler
    // Do not modify this structure — it mirrors the working manual workflow exactly.
    const workflow = {
        "9": {
            "inputs": {
                "filename_prefix": "z-image-turbo",
                "images": ["57:8", 0]
            },
            "class_type": "SaveImage"
        },
        "57:30": {
            "inputs": {
                "clip_name": "qwen_3_4b.safetensors",
                "type": "lumina2",
                "device": "default"
            },
            "class_type": "CLIPLoader"
        },
        "57:29": {
            "inputs": {
                "vae_name": "ae.safetensors"
            },
            "class_type": "VAELoader"
        },
        "57:33": {
            "inputs": {
                "conditioning": ["57:27", 0]
            },
            "class_type": "ConditioningZeroOut"
        },
        "57:8": {
            "inputs": {
                "samples": ["57:3", 0],
                "vae": ["57:29", 0]
            },
            "class_type": "VAEDecode"
        },
        "57:28": {
            "inputs": {
                "unet_name": "z_image_turbo_bf16.safetensors",
                "weight_dtype": "default"
            },
            "class_type": "UNETLoader"
        },
        "57:27": {
            "inputs": {
                "text": finalPrompt,
                "clip": ["57:30", 0]
            },
            "class_type": "CLIPTextEncode"
        },
        "57:13": {
            "inputs": {
                "width": 1920,
                "height": 1080,
                "batch_size": 1
            },
            "class_type": "EmptySD3LatentImage"
        },
        "57:11": {
            "inputs": {
                "shift": 3,
                "model": ["57:28", 0]
            },
            "class_type": "ModelSamplingAuraFlow"
        },
        "57:3": {
            "inputs": {
                "seed": Math.floor(Math.random() * 2147483647),
                "steps": 8,
                "cfg": 1,
                "sampler_name": "res_multistep",
                "scheduler": "simple",
                "denoise": 1,
                "model": ["57:11", 0],
                "positive": ["57:27", 0],
                "negative": ["57:33", 0],
                "latent_image": ["57:13", 0]
            },
            "class_type": "KSampler"
        }
    };

    // ── STEP 1: Submit workflow to ComfyUI ───────────────────────────────────
    log('ComfyUI', 'STEP 1 — Submitting prompt to ComfyUI...');
    let promptRes;
    try {
        promptRes = await fetch(`${baseUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        });
    } catch (err) {
        throw new Error(`ComfyUI connection failed — is ComfyUI running at ${baseUrl}? (${err.message})`);
    }

    if (!promptRes.ok) {
        const text = await promptRes.text();
        throw new Error(`ComfyUI /prompt error (${promptRes.status}): ${text}`);
    }

    const { prompt_id } = await promptRes.json();
    if (!prompt_id) {
        throw new Error('ComfyUI did not return a prompt_id.');
    }
    log('ComfyUI', `Prompt submitted, prompt_id: ${prompt_id}`);

    // ── STEP 2: Poll /history/<prompt_id> until job completes ────────────────
    log('ComfyUI', 'STEP 2 — Polling /history for completion...');
    const pollIntervalMs = 1500;
    const pollTimeoutMs = 120000; // 2 minutes
    const startTime = Date.now();
    let historyData = null;

    while (Date.now() - startTime < pollTimeoutMs) {
        await new Promise(r => setTimeout(r, pollIntervalMs));

        let historyRes;
        try {
            historyRes = await fetch(`${baseUrl}/history/${prompt_id}`);
        } catch {
            // Retry on network error
            continue;
        }

        if (!historyRes.ok) continue;

        historyData = await historyRes.json();

        // ComfyUI returns { [prompt_id]: { outputs: {...}, status: {...} } }
        if (historyData && historyData[prompt_id]) {
            const item = historyData[prompt_id];
            if (item.status?.status_str === 'error') {
                const errorMessages = item.status?.messages
                    ?.filter(m => m[0] === 'execution_error')
                    ?.map(m => m[1])
                    ?.map(m => `${m.node_type} [${m.node_id}] ${m.exception_type}: ${m.exception_message}`)
                    ?.join('\n') || 'Unknown ComfyUI execution error';
                throw new Error(`ComfyUI generation failed:\n${errorMessages}`);
            }
            if (item.outputs && Object.keys(item.outputs).length > 0) {
                log('ComfyUI', 'Job completed.');
                break;
            }
        }

        log('ComfyUI', 'Still waiting...');
        historyData = null;
    }

    if (!historyData || !historyData[prompt_id]) {
        throw new Error(`ComfyUI generation timed out after ${pollTimeoutMs / 1000}s.`);
    }

    // ── STEP 3: Extract image metadata from outputs ─────────────────────────
    log('ComfyUI', 'STEP 3 — Extracting image metadata from outputs...');
    const outputs = historyData[prompt_id].outputs;
    const allImages = Object.values(outputs)
        .flatMap(o => o.images || o.gifs || []);
    const imgInfo = allImages[0];

    if (!imgInfo) {
        throw new Error('ComfyUI completed but no images found in outputs.');
    }

    const { filename: imgFilename, subfolder, type } = imgInfo;
    log('ComfyUI', `Image found: ${imgFilename} (subfolder="${subfolder}", type="${type}")`);

    // ── STEP 4: Fetch the rendered image binary ─────────────────────────────
    log('ComfyUI', 'STEP 4 — Fetching rendered image...');
    const viewUrl = new URL(`${baseUrl}/view`);
    viewUrl.searchParams.set('filename', imgFilename);
    viewUrl.searchParams.set('subfolder', subfolder || '');
    viewUrl.searchParams.set('type', type || 'output');

    let viewRes;
    try {
        viewRes = await fetch(viewUrl.toString());
    } catch (err) {
        throw new Error(`ComfyUI /view connection failed: ${err.message}`);
    }

    if (!viewRes.ok) {
        const text = await viewRes.text();
        throw new Error(`ComfyUI /view error (${viewRes.status}): ${text}`);
    }

    const blob = await viewRes.blob();
    log('ComfyUI', `Rendered image fetched (${blob.size} bytes).`);

    // ── STEP 5: Upload to ST backgrounds store ──────────────────────────────
    log('ComfyUI', 'STEP 5 — Uploading to ST backgrounds store...');
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

/**
 * Generates a background image and uploads it to the server.
 * Routes to Pollinations, Local SD, or ComfyUI based on the generationBackend setting.
 *
 * @param {string} key The location key
 * @param {object} locationDef The location definition
 * @param {string} sessionId The current session ID
 * @returns {Promise<string>} The uploaded filename
 */
export async function generate(key, locationDef, sessionId) {
    const filename = `vistalyze_${sessionId}_${key}.png`
    const template = getSettings().imagePromptTemplate ?? DEFAULT_IMAGE_PROMPT_TEMPLATE
    const finalPrompt = interpolateImagePrompt(template, locationDef)
    const backend = getSettings().generationBackend ?? 'pollinations'

    if (backend === 'comfyui') {
        return generateViaComfyUI(finalPrompt, filename)
    }

    if (backend === 'localsd') {
        return generateViaLocalSD(finalPrompt, filename)
    }

    // Default: Pollinations
    const url = buildPollinationsUrl(finalPrompt)
    const headers = await getAuthHeaders()
    
    const imgRes = await fetch(url, { headers })
    await validateImageResponse(imgRes)
    
    const blob = await imgRes.blob()
    const file = new File([blob], filename, { type: 'image/png' })

    const formData = new FormData()
    formData.append('avatar', file)

    const res = await fetch('/api/backgrounds/upload', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
    })

    if (!res.ok) throw new Error(`Background upload failed: ${res.status} ${res.statusText}`)

    return filename
}
