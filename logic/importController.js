/**
 * @file data/default-user/extensions/vistalyze/logic/importController.js
 * @stamp {"utc":"2026-05-06T17:00:00.000Z"}
 * @architectural-role Stateful Orchestrator / Import Manager
 * @description
 * Manages the "Global Library" workflow. Handles character discovery, 
 * asynchronous chat scanning, and narrative merging of foreign locations.
 *
 * @updates
 * - Implemented character-scoped chat discovery.
 * - Added dual-path parser for modern (extra.vistalyze) and legacy (vistalyze) DNA.
 * - Implemented Collision Management: Skip, Overwrite, and Rename.
 * - Integrated Swipe-Safe writing: Imports are pinned to the latest User message.
 * - Added in-memory scan caching to optimize repeated modal interactions.
 *
 * @api-declaration
 * getAvailableCharacters() -> object[]
 * fetchCharacterChats(avatarUrl) -> Promise<string[]>
 * scanChat(avatarUrl, chatFilename, characterName) -> Promise<object[]>
 * performImport(importList, behavior) -> Promise<number>
 *
 * @contract
 *   assertions:
 *     purity: Stateful Orchestrator
 *     state_ownership: [state._importCache (mutates via setters)]
 *     external_io: [ST API (/api/characters/chats, /api/chats/get), DNA Writer]
 */

import { characters, getRequestHeaders, callPopup } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { translate } from '../../../../i18n.js';
import { state, setImportCache, upsertLocation } from '../state.js';
import { lockedWriteLocationDef } from '../io/dnaWriter.js';
import { slugify } from '../utils/history.js';
import { log, error } from '../utils/logger.js';

/**
 * Returns the list of characters for the grid view.
 */
export function getAvailableCharacters() {
    return characters.map(c => ({
        name: c.name,
        avatar: c.avatar,
    }));
}

/**
 * Fetches the list of chat filenames for a specific character.
 * Caches result in state._importCache.
 */
export async function fetchCharacterChats(avatarUrl) {
    if (state._importCache.chatList[avatarUrl]) {
        return state._importCache.chatList[avatarUrl];
    }

    const res = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatarUrl }),
    });
    
    const data = await res.json();
    const chats = Array.isArray(data) ? data : [];
    
    setImportCache('chatList', avatarUrl, chats);
    return chats;
}

/**
 * Scans a foreign chat file for Vistalyze location definitions.
 * @returns {Promise<{locations: object[], snippet: string}>}
 */
export async function scanChat(avatarUrl, chatFilename, characterName) {
    if (state._importCache.locationLibrary[chatFilename]) {
        return state._importCache.locationLibrary[chatFilename];
    }

    const res = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ch_name: characterName,
            file_name: chatFilename.replace('.jsonl', ''),
            avatar_url: avatarUrl,
        }),
    });

    const messages = await res.json();
    if (!Array.isArray(messages)) return [];

    const discovered = [];
    const seenKeys = new Set();
    let foreignSessionId = null;

    for (const msg of messages) {
        const vistalyze = msg.extra?.vistalyze ?? msg.vistalyze;
        if (!vistalyze) continue;

        const records = Array.isArray(vistalyze) ? vistalyze : [vistalyze];

        for (const rec of records) {
            // Capture the session ID of the foreign chat to link assets
            if (!foreignSessionId && rec.sessionId) {
                foreignSessionId = rec.sessionId;
            }

            if (rec.type === 'location_def') {
                // If the record already has a source, preserve it (chained borrow)
                // Otherwise, the foreign chat's own session becomes the source.
                const entry = {
                    ...rec,
                    sourceSessionId: rec.sourceSessionId ?? rec.sessionId ?? foreignSessionId
                };

                // Last write wins for a key within the same chat
                const existingIdx = discovered.findIndex(d => d.key === entry.key);
                if (existingIdx !== -1) {
                    discovered[existingIdx] = entry;
                } else {
                    discovered.push(entry);
                }
            }
        }
    }

    const lastMsg = [...messages].reverse().find(m => typeof m.mes === 'string' && m.mes.trim().length > 0);
    const snippet = lastMsg ? lastMsg.mes.trim().replace(/\s+/g, ' ').slice(0, 120) : '';

    const result = { locations: discovered, snippet };
    setImportCache('locationLibrary', chatFilename, result);
    return result;
}

/**
 * Merges a list of foreign locations into the current chat.
 * @param {object[]} importList List of location_def objects.
 * @param {'skip'|'overwrite'|'rename'} behavior 
 * @returns {number} Count of successfully imported locations.
 */
export async function performImport(importList, behavior) {
    const context = getContext();
    
    // Find swipe-safe User message for DNA storage
    let targetId = 0;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (context.chat[i].is_user) {
            targetId = i;
            break;
        }
    }

    let count = 0;
    for (const loc of importList) {
        let finalLoc = { ...loc };
        const exists = !!state.locations[loc.key];

        if (exists) {
            if (behavior === 'skip') continue;
            if (behavior === 'rename') {
                const suffix = `_${Math.random().toString(36).slice(2, 5)}`;
                finalLoc.name = `${loc.name} (Imported)`;
                finalLoc.key = slugify(loc.name + suffix);
            }
            // 'overwrite' simply falls through to write the record
        }

        log('Import', `Importing location: ${finalLoc.key} (Source: ${finalLoc.sourceSessionId})`);
        
        await lockedWriteLocationDef(targetId, finalLoc, state.sessionId);
        
        // Protected Update: Hydrate live library
        upsertLocation(finalLoc);
        count++;
    }

    return count;
}