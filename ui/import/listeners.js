/**
 * @file data/default-user/extensions/vistalyze/ui/import/listeners.js
 * @stamp {"utc":"2026-05-06T19:00:00.000Z"}
 * @architectural-role UI Event Listeners
 * @description
 * Centralizes all DOM event bindings for the Global Library (Import) modal.
 *
 * @updates
 * - Implemented Character -> Chat folder navigation.
 * - Implemented accordion toggling for chat folders.
 * - Implemented collision resolution logic (Skip/Overwrite/Rename).
 * - Added hover preview tooltips for bulk import actions.
 * - Integrated character-scoped scan logic via importController.js.
 *
 * @api-declaration
 * bindImportEvents(handlers) -> void
 *
 * @contract
 *   assertions:
 *     purity: IO / Controller
 *     state_ownership: []
 *     external_io: [importController.js, templates.js, callPopup, JQuery DOM]
 */

import { callPopup } from '../../../../../script.js';
import { t, translate } from '../../../../i18n.js';
import { state } from '../../state.js';
import { 
    fetchCharacterChats, 
    scanChat, 
    performImport 
} from '../../logic/importController.js';
import { 
    getChatFolderHTML, 
    getExpandedLocationsHTML, 
    getCollisionModalHTML 
} from './templates.js';

/**
 * Binds all listeners for the Global Library UI.
 * @param {object} handlers { renderCharacters, renderChats, closeLibrary }
 */
export function bindImportEvents(handlers) {
    const { renderCharacters, renderChats, closeLibrary } = handlers;
    const $overlay = $('#lz-import-overlay');

    // ─── Navigation ──────────────────────────────────────────────────────

    // Select character -> Show their chats
    $overlay.on('click', '.lz-import-char-card', async function() {
        const avatar = $(this).data('avatar');
        const name = $(this).data('name');
        
        // Show spinner
        $('#lz-import-body').html(`<div style="text-align:center; padding:50px; opacity:0.6;"><i class="fa-solid fa-spinner fa-spin"></i> ${translate('Scanning Archives...')}</div>`);
        
        try {
            const chatFiles = await fetchCharacterChats(avatar);
            const chatSummaries = [];

            // Fast-pass scan for each chat to check for location counts
            for (const filename of chatFiles) {
                const locations = await scanChat(avatar, filename, name);
                if (locations.length > 0) {
                    chatSummaries.push({
                        filename,
                        count: locations.length,
                        // Attempt to extract snippet from first message
                        snippet: locations[0].chatSnippet || '' 
                    });
                }
            }
            
            renderChats(name, avatar, chatSummaries);
        } catch (err) {
            $('#lz-import-body').html(`<p style="text-align:center; padding:20px; color:var(--SmartThemeErrorColor);">${translate('Scan failed. See console.')}</p>`);
        }
    });

    // Back to character grid
    $overlay.on('click', '#lz-import-back', () => renderCharacters());

    // Close button
    $overlay.on('click', '#lz-import-close', () => closeLibrary());

    // ─── Folder Interactions ─────────────────────────────────────────────

    // Toggle accordion
    $overlay.on('click', '.lz-folder-header', async function(e) {
        if ($(e.target).closest('.lz-import-all-btn').length) return; // Ignore if clicking button

        const $folder = $(this).closest('.lz-import-folder');
        const $content = $folder.find('.lz-folder-content');
        const $chevron = $folder.find('.lz-folder-toggle');
        const filename = $folder.data('filename');
        const avatar = $('#lz-import-current-avatar').val();
        const charName = $('#lz-import-current-name').val();

        if ($content.hasClass('lz-hidden')) {
            $content.html(`<div style="padding:10px; opacity:0.5;"><i class="fa-solid fa-spinner fa-spin"></i></div>`).removeClass('lz-hidden');
            $chevron.css('transform', 'rotate(180deg)');
            
            const locations = await scanChat(avatar, filename, charName);
            $content.html(getExpandedLocationsHTML(locations, state.fileIndex));
        } else {
            $content.addClass('lz-hidden');
            $chevron.css('transform', 'rotate(0deg)');
        }
    });

    // ─── Tooltip Preview ─────────────────────────────────────────────────

    $overlay.on('mouseenter', '.lz-import-all-btn', async function() {
        const $folder = $(this).closest('.lz-import-folder');
        const filename = $folder.data('filename');
        const avatar = $('#lz-import-current-avatar').val();
        const charName = $('#lz-import-current-name').val();
        
        const locations = await scanChat(avatar, filename, charName);
        const names = locations.map(l => l.name).slice(0, 5);
        let tip = names.join(', ');
        if (locations.length > 5) tip += t` and ${locations.length - 5} more...`;
        
        $(this).attr('title', `${translate('Imports:')} ${tip}`);
    });

    // ─── Collision & Import Execution ────────────────────────────────────

    /**
     * Resolves key collisions before committing the import.
     */
    async function resolveAndImport(importList) {
        const conflicts = importList.filter(loc => !!state.locations[loc.key]);
        
        let behavior = 'overwrite';
        if (conflicts.length > 0) {
            const popupPromise = callPopup(getCollisionModalHTML(importList.length, conflicts.length), 'text');
            
            behavior = await new Promise((resolve) => {
                $('#lz-collision-skip').on('click', () => { $('#dialog_overlay .menu_button:last').click(); resolve('skip'); });
                $('#lz-collision-overwrite').on('click', () => { $('#dialog_overlay .menu_button:last').click(); resolve('overwrite'); });
                $('#lz-collision-rename').on('click', () => { $('#dialog_overlay .menu_button:last').click(); resolve('rename'); });
                // If closed without choice, default to null (cancel)
            });
        }

        if (!behavior) return;

        const count = await performImport(importList, behavior);
        if (window.toastr) window.toastr.success(t`Imported ${count} locations successfully.`, 'Vistalyze');
    }

    // Bulk Import All
    $overlay.on('click', '.lz-import-all-btn', async function(e) {
        e.stopPropagation();
        const $folder = $(this).closest('.lz-import-folder');
        const filename = $folder.data('filename');
        const avatar = $('#lz-import-current-avatar').val();
        const charName = $('#lz-import-current-name').val();
        const $btn = $(this);

        const originalHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');

        const locations = await scanChat(avatar, filename, charName);
        await resolveAndImport(locations);

        $btn.html('<i class="fa-solid fa-check"></i>').addClass('success');
        setTimeout(() => $btn.prop('disabled', false).html(originalHtml).removeClass('success'), 2000);
    });

    // Import Single Location
    $overlay.on('click', '.lz-import-single-btn', async function(e) {
        e.stopPropagation();
        const $item = $(this).closest('.lz-import-item');
        const key = $item.data('key');
        const $folder = $(this).closest('.lz-import-folder');
        const filename = $folder.data('filename');

        const chatLocations = state._importCache.locationLibrary[filename] || [];
        const loc = chatLocations.find(l => l.key === key);
        
        if (loc) {
            await resolveAndImport([loc]);
        }
    });
}