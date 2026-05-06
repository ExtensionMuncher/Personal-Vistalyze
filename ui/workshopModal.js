/**
 * @file data/default-user/extensions/vistalyze/ui/workshopModal.js
 * @stamp {"utc":"2026-05-06T23:00:00.000Z"}
 * @architectural-role UI Orchestrator
 * @description
 * High-level coordinator for the Location Workshop. 
 * Updated to synchronize imported data when returning from the Global Library.
 *
 * @updates
 * - Enhanced openWorkshop: Now calls syncDrafts() to ensure the draft state 
 *   reflects any new locations imported from the Global Library.
 * - Standardized renderLibrary: Preserves the sourceSessionId logic for 
 *   imported location thumbnails.
 *
 * @api-declaration
 * renderLibrary()   — updates the Library tab content.
 * renderArchitect() — updates the Architect tab content.
 * switchTab(name)   — toggles visibility and triggers re-renders.
 * injectWorkshop()  — initializes the modal shell and bindings.
 * openWorkshop(tab) — primary entry point to display the modal.
 *
 * @contract
 *   assertions:
 *     purity: Stateful UI Shell
 *     state_ownership: []
 *     external_io: [JQuery DOM (write), templates.js, listeners.js, i18n]
 */

import { translate } from '../../../../i18n.js';
import { state, setWorkshopKey, syncDrafts } from '../state.js';
import { 
    getBaseWorkshopHTML, 
    getLibraryListHTML, 
    getArchitectGridHTML, 
    getArchitectEmptyHTML 
} from './workshop/templates.js';
import { bindWorkshopEvents } from './workshop/listeners.js';

/**
 * Renders the Library list based on _draftLocations.
 */
export function renderLibrary() {
    const drafts = Object.entries(state._draftLocations);
    const html = getLibraryListHTML(drafts, state.currentLocation, state.fileIndex, state.sessionId);
    $('.lz-library-list').html(html);

    // Sync footer button text if we have an active key
    const key = state._activeWorkshopKey;
    const draft = state._draftLocations[key];
    const $altBtn = $('#lz-workshop-alt-bg');

    if (!draft) {
        $altBtn.text(translate('Select existing')).prop('disabled', true);
    } else {
        const text = draft.customBg ? translate('Clear manual selection') : translate('Select existing');
        $altBtn.text(text).prop('disabled', false);
    }
}

/**
 * Renders the Architect tab for the current active workshop key.
 */
export async function renderArchitect() {
    // Default to current location if none selected
    if (!state._activeWorkshopKey && state.currentLocation && state._draftLocations[state.currentLocation]) {
        setWorkshopKey(state.currentLocation);
    }

    const key = state._activeWorkshopKey;
    const draft = state._draftLocations[key];
    const $container = $('#lz-tab-architect');
    const $altBtn = $('#lz-workshop-alt-bg');

    if (!draft) {
        $container.html(getArchitectEmptyHTML());
        $altBtn.text(translate('Select existing')).prop('disabled', true);
        return;
    }

    // Toggle footer button text based on customBg state
    const altBtnText = draft.customBg ? translate('Clear manual selection') : translate('Select existing');
    $altBtn.text(altBtnText).prop('disabled', false);

    // Resolve Image: Custom > Borrowed (Source Session) > Native (Current Session)
    const sourceId = draft.sourceSessionId || state.sessionId;
    const filename = draft.customBg || (sourceId ? `vistalyze_${sourceId}_${key}.png` : null);

    const currentImgUrl = (filename && (!!draft.customBg || state.fileIndex.has(filename)))
        ? `backgrounds/${encodeURIComponent(filename)}?v=${Date.now()}` 
        : '';
        
    let proposedImgUrl = '';
    let proposedLabel = translate('Proposed');

    if (state._proposedFullBlob) {
        proposedImgUrl = state._proposedFullBlob;
        proposedLabel = translate('Full Resolution');
    } else if (state._proposedImageBlob) {
        proposedImgUrl = state._proposedImageBlob;
        proposedLabel = translate('Thumbnail Preview');
    }

    $container.html(getArchitectGridHTML(draft, currentImgUrl, proposedImgUrl, proposedLabel));
}

/**
 * Switches the active tab and triggers the appropriate render logic.
 */
export function switchTab(tabName) {
    $('.lz-tab-btn').removeClass('lz-active');
    $(`.lz-tab-btn[data-tab="${tabName}"]`).addClass('lz-active');
    
    $('.lz-tab-panel').addClass('lz-hidden');
    $(`#lz-tab-${tabName}`).removeClass('lz-hidden');

    if (tabName === 'library') renderLibrary();
    if (tabName === 'architect') renderArchitect();
}

/**
 * Entry point to inject the workshop and bind its listeners.
 */
export function injectWorkshop() {
    if ($('#lz-workshop-overlay').length) return;
    
    $('body').append(getBaseWorkshopHTML(state.sessionId));
    
    bindWorkshopEvents({
        switchTab,
        renderLibrary,
        renderArchitect
    });
}

/**
 * Primary entry point to display the Workshop modal.
 * Synchronizes the draft state to ensure imported locations are visible.
 */
export function openWorkshop(tab = 'library') {
    syncDrafts(); // Sync live library (including imports) to the workshop draft
    injectWorkshop();
    $('#lz-workshop-overlay').removeClass('lz-hidden');
    switchTab(tab);
}