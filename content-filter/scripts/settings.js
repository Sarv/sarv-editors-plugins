/*
 * Content Filter Plugin — the panel's Settings view  v1.4.0
 *
 * The four values a user may change, edited in place inside the panel instead of in a modal
 * window of their own. The plugin declares a single variation, so its toolbar button is a
 * plain button like every other plugin's - one hover region, its icon spaced like the rest -
 * and there is no dropdown left to hang a Settings entry off.
 *
 * Owns no plugin lifecycle hook: scripts/script.js opens this view and decides when to read
 * and write it. The storage keys, the defaults and the config reader/writer come from
 * scripts/policy-core.js, shared with the worker, so nothing here is a second copy of them.
 */
(function (window) {
    'use strict';

    var core = window.SarvContentPolicy;

    var tr = function (text) {
        return (window.Asc && window.Asc.plugin && window.Asc.plugin.tr)
            ? window.Asc.plugin.tr(text) : text;
    };

    var field = function (id) { return window.document.getElementById(id); };

    var intOf = function (id, fallback) {
        return parseInt(field(id).value, 10) || fallback;
    };

    /** What the stored cache holds, in one line - or why there is nothing to describe. */
    var describeCache = function (entry) {
        if (!entry || !entry.timestamp) return tr('No cache');
        var rules      = entry.rules || core.emptyRules(),
            allowed    = (rules.allowed || []).length,
            disallowed = (rules.disallowed || []).length;
        var parts = [
            tr('Cached') + ': ' + (allowed + disallowed) + ' ' + tr('rules') +
                ' (' + disallowed + ' ' + tr('disallowed') + ', ' + allowed + ' ' + tr('allowed') + ')',
            tr('synced') + ' ' + new Date(entry.timestamp).toLocaleString()
        ];
        if (entry.lastRecordDate) parts.push(tr('last record date') + ': ' + entry.lastRecordDate);
        return parts.join(' — ');
    };

    var refreshCacheInfo = function () {
        var el = field('cache-info');
        if (el) el.textContent = describeCache(core.readCache());
    };

    /** Fills the form from what is stored, falling back to the shared defaults. */
    var populate = function () {
        var config = core.getConfig();
        field('f-auto-remove').value   = config.autoRemoveDelay !== undefined ? config.autoRemoveDelay : 0;
        field('f-scan-interval').value = config.scanIntervalMs !== undefined
            ? config.scanIntervalMs : core.DEFAULT_SCAN_MS;
        field('f-cache-hours').value   = config.cacheTtlHours || core.DEFAULT_CACHE_HRS;
        refreshCacheInfo();
    };

    /** Stores what the form holds, and hands it back so the caller can apply it at once. */
    var save = function () {
        var config = core.getConfig();
        config.autoRemoveDelay = intOf('f-auto-remove', 0);
        config.scanIntervalMs  = intOf('f-scan-interval', core.DEFAULT_SCAN_MS);
        config.cacheTtlHours   = intOf('f-cache-hours', core.DEFAULT_CACHE_HRS);
        core.writeConfig(config);
        return config;
    };

    /** Drops the rules kept on this machine; the next sync fetches the whole list again. */
    var clearCache = function () {
        window.localStorage.removeItem(core.CACHE_KEY);
        refreshCacheInfo();
    };

    window.SarvContentFilterSettings = {
        populate:         populate,
        save:             save,
        clearCache:       clearCache,
        refreshCacheInfo: refreshCacheInfo
    };

})(window);
