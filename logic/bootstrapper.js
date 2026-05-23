/**
 * @file data/default-user/extensions/vistalyze/logic/bootstrapper.js
 * @stamp {"utc":"2026-04-03T15:30:00.000Z"}
 * @version 1.2.0
 * @architectural-role Orchestrator / Boot Sequence
 * @description
 * Manages the initialization of the Vistalyze environment for a specific chat.
 *
 * @updates
 * - v1.2.0: Removed bulk self-healing regeneration queue. The boot sequence
 *   now ONLY regenerates the current scene's image if missing — it no longer
 *   regenerates ALL missing locations' images, which caused intentionally
 *   deleted files to reappear. Non-current locations are regenerated on-demand
 *   by the pipeline when visited. Image corruption detection was added to the
 *   pipeline's handleKnownLocation path for robustness.
 *
 * @api-declaration
 * runBoot() -> Promise<void>
 *
 * @contract
 *   assertions:
 *     purity: Stateful IO
 *     state_ownership: [state (mutates via setters only)]
 *     external_io: [session, reconstruction, imageCache, background, orphanDetector]
 */

import { saveSettingsDebounced, chat_metadata } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { log, warn, error } from '../utils/logger.js';
import { state, bulkInitState, setFileIndex, addToFileIndex, addToAllImages, updateState, setAllImages } from '../state.js';
import { initSession } from '../session.js';
import { reconstruct } from '../reconstruction.js';
import { fetchFileIndex, generate } from '../imageCache.js';
import { findCrossSessionImage } from './pipeline.js';
import { set as setBg, clear as clearBg } from '../background.js';
import { fastDiff } from '../orphanDetector.js';
import { showOrphanBadge } from '../ui/toolbar.js';
import { getMetaSettings, updateMetaSetting } from '../settings/data.js';

/**
 * Extracts the location key from a Vistalyze filename.
 * Format: vistalyze_{sessionId}_{key}.png
 * @param {string} filename
 * @returns {string|null}
 */
function extractKeyFromFilename(filename) {
    if (!filename || typeof filename !== 'string') return null;
    const parts = filename.split('_');
    // parts[0] = 'vistalyze', parts[1] = sessionId, rest = key (may contain underscores) minus '.png'
    if (parts.length < 3) return null;
    // The key is everything after sessionId (parts[1]), minus the .png extension
    const keyParts = parts.slice(2);
    const last = keyParts.length - 1;
    keyParts[last] = keyParts[last].replace(/\.png$/, '');
    return keyParts.join('_');
}

/**
 * Executes the full boot sequence for the current chat context.
 */
export async function runBoot() {
    log('Boot', 'Starting sequence...');

    const context = getContext();
    if (!context.chatId) {
        log('Boot', 'Abort: No active chatId found.');
        return;
    }

    log('Boot', 'runBoot() entry — chat_metadata:', {
        custom_background: chat_metadata?.custom_background ?? '(not set)',
        vistalyze_managed:  chat_metadata?.vistalyze_managed  ?? '(not set)',
    });

    // 1. Session & DNA Reconstruction
    // Derives the library and the "last known scene" from the chat JSONL.
    initSession();
    
    const reconstructed = reconstruct(context.chat);
    
    // Protected Update: Hydrate live state from reconstructed DNA
    bulkInitState(reconstructed);
    
    log('Boot', `DNA Reconstructed: ${Object.keys(state.locations).length} locations found.`);

    // 2. Filesystem Reconciliation
    // Fetch the list of actual background files present on the server.
    const { fileIndex, allImages } = await fetchFileIndex(state.sessionId);

    // Protected Update: Update the server asset cache
    setFileIndex(fileIndex);
    setAllImages(allImages);  // Store unfiltered list for API-call prevention

    log('Boot', `File Index: ${state.fileIndex.size} managed files detected. Total backgrounds on server: ${allImages.length}.`);

    // 3. UI Restoration — Current Scene Only
    // We ONLY try to restore the current scene's image. Other locations' images
    // are regenerated on-demand by the pipeline when visited. This prevents
    // intentionally deleted files from being bulk-regenerated on every boot.
    //
    // Handle the two-write pattern: Write 1 writes { location: key, image: null },
    // then async-patched with the actual filename. After reconstruction, currentImage
    // may be null even though currentLocation is set. In that case, construct the
    // expected filename from sessionId + currentLocation.
    const expectedFilename = state.currentImage || (
        state.currentLocation && state.sessionId
            ? `vistalyze_${state.sessionId}_${state.currentLocation}.png`
            : null
    );
    const currentKey = state.currentLocation || (expectedFilename ? extractKeyFromFilename(expectedFilename) : null);
    const isImageMissing = expectedFilename &&
        !state.fileIndex.has(expectedFilename) &&
        !state.allImages.includes(expectedFilename);

    if (expectedFilename && !isImageMissing) {
        // File found — could be in fileIndex OR in allImages under old sessionId
        log('Boot', 'Restoring valid background:', expectedFilename);
        addToFileIndex(expectedFilename);
        setBg(expectedFilename);
    } else if (isImageMissing) {
        // Before calling the API, check if the file exists ANYWHERE on the server
        // (including under a different sessionId or naming variant).
        // If it does, use it directly instead of regenerating.
        const fileExistsOnServer = expectedFilename && state.allImages.includes(expectedFilename);

        if (fileExistsOnServer) {
            log('Boot', `Background "${expectedFilename}" found on server (outside session filter). Using existing file.`);
            addToFileIndex(expectedFilename);
            setBg(expectedFilename);
            // Also patch the current chat's DNA with the found filename
            const context = getContext();
            const lastMsgId = context.chat.length - 1;
            const { lockedPatchSceneImage } = await import('../io/dnaWriter.js');
            lockedPatchSceneImage(lastMsgId, expectedFilename).catch(() => {});
            return;
        }

        // Cross-session fallback: check if ANY vistalyze_*_<key>.png exists on the server
        // (e.g., generated under a previous sessionId before a chat reset/reimport).
        if (currentKey) {
            const crossSessionFile = findCrossSessionImage(currentKey, state.allImages);
            if (crossSessionFile) {
                log('Boot', `Background for "${currentKey}" found cross-session: "${crossSessionFile}". Using existing file.`);
                addToFileIndex(crossSessionFile);
                updateState(currentKey, crossSessionFile);
                setBg(crossSessionFile);
                // Patch DNA with the cross-session filename
                const context = getContext();
                const lastMsgId = context.chat.length - 1;
                const { lockedPatchSceneImage } = await import('../io/dnaWriter.js');
                lockedPatchSceneImage(lastMsgId, crossSessionFile).catch(() => {});
                return;
            }
        }

        warn('Boot', `Active background "${expectedFilename}" not found anywhere on server. Attempting targeted regeneration...`);
        clearBg();

        const currentDef = currentKey ? state.locations[currentKey] : null;

        if (currentDef) {
            generate(currentKey, currentDef, state.sessionId)
                .then(async newFile => {
                    log('Boot', `Current background regenerated: ${newFile}`);
                    addToFileIndex(newFile);
                    addToAllImages(newFile);
                    updateState(currentKey, newFile);
                    setBg(newFile);
                })
                .catch(err => {
                    error('Boot', `Targeted regeneration failed for current background:`, err);
                });
        } else {
            warn('Boot', `Could not find location definition for key "${currentKey}". Background cleared.`);
        }
    } else {
        clearBg();
    }

    // 4. Fast Orphan Detection (Badge Update)
    const meta = getMetaSettings();
    const suspects = fastDiff(allImages, meta?.knownSessions ?? []);
    if (suspects.length > 0) {
        // Protected Update: Update global audit metadata
        const newAuditCache = {
            ...(meta.auditCache ?? {}),
            suspects: suspects
        };
        updateMetaSetting('auditCache', newAuditCache);
        
        showOrphanBadge(suspects.length);
    }
}