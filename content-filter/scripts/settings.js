/*
 * Content Filter Plugin — settings page script  v1.1.0
 *
 * Only 4 user-configurable values remain:
 *   apiUrl, autoRemoveDelay, scanIntervalMs, cacheTtlHours
 *
 * All API params (size, skip, since, userId) and field mappings
 * are fixed in the main script and not user-configurable.
 */
(function () {
    'use strict';

    var CONFIG_KEY = 'CONTENT_FILTER_CONFIG';
    var CACHE_KEY  = 'CONTENT_FILTER_CACHE';

    function getConfig() {
        try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; }
        catch (e) { return {}; }
    }

    function getCacheEntry() {
        try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || null; }
        catch (e) { return null; }
    }

    function val(id)       { return document.getElementById(id).value.trim(); }
    function setVal(id, v) { document.getElementById(id).value = v; }

    function populateForm() {
        var cfg = getConfig();

        setVal('f-api-url',       cfg.apiUrl           || '');
        setVal('f-auto-remove',   cfg.autoRemoveDelay  !== undefined ? cfg.autoRemoveDelay : 0);
        setVal('f-scan-interval', cfg.scanIntervalMs   !== undefined ? cfg.scanIntervalMs  : 3000);
        setVal('f-cache-hours',   cfg.cacheTtlHours    || 24);

        updateCacheInfo();
    }

    function updateCacheInfo() {
        var entry = getCacheEntry();
        var el    = document.getElementById('cache-info');
        if (!entry || !entry.timestamp) {
            el.textContent = window.Asc.plugin.tr('No cache');
            return;
        }
        var r         = entry.rules || {};
        var nAllow    = (r.allowed    || []).length;
        var nDisallow = (r.disallowed || []).length;
        var parts = [
            window.Asc.plugin.tr('Cached') + ': ' + (nAllow + nDisallow) + ' ' +
                window.Asc.plugin.tr('rules') +
                ' (' + nDisallow + ' ' + window.Asc.plugin.tr('disallowed') +
                ', ' + nAllow + ' ' + window.Asc.plugin.tr('allowed') + ')',
            window.Asc.plugin.tr('synced') + ' ' + new Date(entry.timestamp).toLocaleString()
        ];
        if (entry.lastRecordDate) {
            parts.push(window.Asc.plugin.tr('last record date') + ': ' + entry.lastRecordDate);
        }
        el.textContent = parts.join(' \u2014 ');
    }

    function saveForm() {
        var cfg = getConfig();

        cfg.apiUrl          = val('f-api-url');
        cfg.autoRemoveDelay = parseInt(val('f-auto-remove'),   10) || 0;
        cfg.scanIntervalMs  = parseInt(val('f-scan-interval'), 10) || 3000;
        cfg.cacheTtlHours   = parseInt(val('f-cache-hours'),   10) || 24;

        localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    }

    window.Asc.plugin.init = function () {
        populateForm();

        document.getElementById('btn-clear-cache').addEventListener('click', function () {
            localStorage.removeItem(CACHE_KEY);
            updateCacheInfo();
        });
    };

    window.Asc.plugin.button = function (id) {
        if (id === 0) saveForm();
        window.Asc.plugin.executeCommand('close', '');
    };

    window.Asc.plugin.onTranslate    = function () { updateCacheInfo(); };
    window.Asc.plugin.onThemeChanged = function (theme) {
        window.Asc.plugin.onThemeChangedBase(theme);
    };

})();
