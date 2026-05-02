/*
 * Content Filter Plugin — main script  v1.1.0
 *
 * Auto-scans documents for disallowed/allowed content.
 * - Event-driven: fires on every selection change (initOnSelectionChanged)
 * - Interval fallback for Word (catches edits without cursor moves)
 * - API params are fixed: userId, size=2000, skip, since
 * - Incremental sync: stores lastRecordDate, only fetches new records on reload
 * - Tabs: Violations | Disallowed | Allowed | Removed history
 * - Countdown auto-remove + per-violation Remove button
 * - beforeunload warning when violations exist
 */
(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────
    // DEPLOYMENT CONFIGURATION
    // Set API_URL to your content-rules endpoint before publishing.
    // This is an org-wide setting — end users never see or change it.
    // The endpoint is secured by IP allowlisting on the server side.
    // ─────────────────────────────────────────────────────────
    var API_URL = 'https://mocki.io/v1/56b54966-e92f-45ec-8baa-cb00e0811d7e';

    // ─────────────────────────────────────────────────────────
    // Constants  (nothing the user changes)
    // ─────────────────────────────────────────────────────────
    var CONFIG_KEY           = 'CONTENT_FILTER_CONFIG';
    var CACHE_KEY            = 'CONTENT_FILTER_CACHE';
    var REMOVAL_HISTORY_KEY  = 'CONTENT_FILTER_REMOVAL_HISTORY';
    var FIXED_PAGE_SIZE      = 2000;           // always 2000 per page
    var MAX_HISTORY_PER_DOC  = 50;            // removal history kept per document
    var MAX_HISTORY_TOTAL    = 500;           // hard cap across all documents in localStorage
    var DEFAULT_CACHE_HRS    = 24;
    var DEFAULT_SCAN_MS      = 3000;

    // ─────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────
    var rules              = { allowed: [], disallowed: [] };
    var currentDocId       = 'default';   // set async in init via GetDocumentInfo
    var isSyncing          = false;
    var isScanRunning      = false;
    var isFirstInit        = true;
    var currentViolations  = [];
    var scanSafetyTimer    = null;   // resets isScanRunning if callCommand never completes
    var lastScanAt         = 0;
    var scanDebounce       = null;
    var countdownInterval  = null;
    var scanIntervalHandle = null;
    var lastSelectedText   = '';     // paragraph/selection text from last init() call

    // Used only by removeWord to pick the right removal API per editor type.
    function isWordEditor() {
        var t = (window.Asc.plugin.info && window.Asc.plugin.info.editorType) || '';
        return t !== 'cell' && t !== 'slide';
    }

    // ─────────────────────────────────────────────────────────
    // callCommand wrapper
    // Uses the 4-argument form: callCommand(fn, bSilent, bAsync, callback)
    // This is the form used by all plugins in this repo (deepl, languagetool etc.)
    // ─────────────────────────────────────────────────────────
    function runDocCmd(fn, cb) {
        window.Asc.plugin.callCommand(fn, undefined, undefined, cb || function () {});
    }

    // ─────────────────────────────────────────────────────────
    // Config  (only 4 user-settable values remain)
    // ─────────────────────────────────────────────────────────
    function getConfig() {
        try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; }
        catch (e) { return {}; }
    }

    // ─────────────────────────────────────────────────────────
    // Cache
    // ─────────────────────────────────────────────────────────
    function getCacheEntry() {
        try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || null; }
        catch (e) { return null; }
    }
    function isCacheValid() {
        var e = getCacheEntry();
        if (!e || !e.timestamp || !e.rules) return false;
        var cfg   = getConfig();
        var ttlMs = (cfg.cacheTtlHours || DEFAULT_CACHE_HRS) * 3600000;
        return (Date.now() - e.timestamp) < ttlMs;
    }
    function saveCache(rulesData, lastRecordDate) {
        var entry = { timestamp: Date.now(), rules: rulesData };
        if (lastRecordDate) entry.lastRecordDate = lastRecordDate;
        localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
    }
    function loadFromCache() {
        var e = getCacheEntry();
        if (e && e.rules) { rules = e.rules; return true; }
        return false;
    }

    // ─────────────────────────────────────────────────────────
    // Removal history  (scoped per document + editor type)
    //
    // Each entry carries a docId so one localStorage key holds all
    // documents without cross-contamination.
    // Cap: 50 entries per document, 500 total across all documents.
    // ─────────────────────────────────────────────────────────
    function getAllHistory() {
        try { return JSON.parse(localStorage.getItem(REMOVAL_HISTORY_KEY)) || []; }
        catch (e) { return []; }
    }
    // Returns only entries for the currently open document.
    function getRemovalHistory() {
        return getAllHistory().filter(function (h) { return h.docId === currentDocId; });
    }
    function addToRemovalHistory(wordsWithMeta, source) {
        var all = getAllHistory();
        var now = new Date().toISOString();
        wordsWithMeta.forEach(function (w) {
            all.unshift({ word: w.text, category: w.category || '', removedAt: now,
                          source: source, docId: currentDocId });
        });
        // Enforce per-doc cap of 50
        var seen = {};
        all = all.filter(function (h) {
            seen[h.docId] = (seen[h.docId] || 0) + 1;
            return seen[h.docId] <= MAX_HISTORY_PER_DOC;
        });
        // Hard total cap
        if (all.length > MAX_HISTORY_TOTAL) all.length = MAX_HISTORY_TOTAL;
        localStorage.setItem(REMOVAL_HISTORY_KEY, JSON.stringify(all));
    }
    // Clears only the current document's history (leaves other docs intact).
    function clearRemovalHistory() {
        var remaining = getAllHistory().filter(function (h) { return h.docId !== currentDocId; });
        localStorage.setItem(REMOVAL_HISTORY_KEY, JSON.stringify(remaining));
    }

    // ─────────────────────────────────────────────────────────
    // API fetch — params are FIXED (not user-configurable)
    //   ?userId=…  &size=2000  &skip=…  [&since=ISO]
    // Security is enforced by IP allowlist on the server side.
    // ─────────────────────────────────────────────────────────
    function fetchPage(apiUrl, skip, since) {
        var url = new URL(apiUrl);
        url.searchParams.set('size', FIXED_PAGE_SIZE);
        url.searchParams.set('skip', skip);
        // Pass the current user so the server can return user-specific rules
        var userId = (window.Asc.plugin.info && window.Asc.plugin.info.userId) || '';
        if (userId) url.searchParams.set('userId', userId);
        if (since)  url.searchParams.set('since',  since);

        return fetch(url.toString())
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
                return res.json();
            });
    }

    function normalizeRecord(raw) {
        var text = String(raw.text || '').trim();
        if (!text) return null;
        return {
            text:     text,
            lower:    text.toLowerCase(),
            type:     String(raw.type || 'disallowed').toLowerCase(),
            category: String(raw.category || ''),
            date:     String(raw.updatedAt || '')
        };
    }

    // Returns Promise<{ rules:{allowed,disallowed}, lastRecordDate:string|null }>
    function fetchAllRules(apiUrl, since) {
        var skip     = 0;
        var collected = [];
        var maxDate  = null;

        function nextPage() {
            return fetchPage(apiUrl, skip, since).then(function (data) {
                var records = Array.isArray(data) ? data : (data.data || []);
                records.forEach(function (raw) {
                    var norm = normalizeRecord(raw);
                    if (!norm) return;
                    collected.push(norm);
                    if (norm.date) {
                        try {
                            var d = new Date(norm.date);
                            if (!isNaN(d.getTime()) && (!maxDate || d > new Date(maxDate)))
                                maxDate = norm.date;
                        } catch (_) {}
                    }
                });
                if (records.length >= FIXED_PAGE_SIZE) {
                    skip += FIXED_PAGE_SIZE;
                    return nextPage();
                }
                return {
                    rules: {
                        allowed:    collected.filter(function (r) { return r.type === 'allowed'; }),
                        disallowed: collected.filter(function (r) { return r.type !== 'allowed'; })
                    },
                    lastRecordDate: maxDate
                };
            });
        }
        return nextPage();
    }

    // ─────────────────────────────────────────────────────────
    // Merge (incremental sync — keys on lower-cased text)
    // ─────────────────────────────────────────────────────────
    function mergeRules(incoming) {
        var map = {};
        function add(r) { map[r.lower] = r; }
        (rules.allowed    || []).forEach(add);
        (rules.disallowed || []).forEach(add);
        (incoming.allowed    || []).forEach(add);
        (incoming.disallowed || []).forEach(add);
        var all = Object.keys(map).map(function (k) { return map[k]; });
        rules = {
            allowed:    all.filter(function (r) { return r.type === 'allowed'; }),
            disallowed: all.filter(function (r) { return r.type !== 'allowed'; })
        };
    }

    // ─────────────────────────────────────────────────────────
    // Sync orchestration
    //
    // On every page load:
    //  1. Serve cached rules instantly (no API wait)
    //  2. If cache still valid: incremental sync in background
    //     — only fetches records updated after lastRecordDate
    //  3. If cache expired: full sync in background
    //  4. After rules are ready: auto-scan starts
    // ─────────────────────────────────────────────────────────
    function doFullSync(onComplete) {
        isSyncing = true;
        updateStatusBar();
        fetchAllRules(API_URL, null)
            .then(function (result) {
                rules     = result.rules;
                isSyncing = false;
                saveCache(result.rules, result.lastRecordDate);
                updateStatusBar();
                updateTabBadges();
                if (onComplete) onComplete();
            })
            .catch(function (err) {
                isSyncing = false;
                loadFromCache();
                showError(window.Asc.plugin.tr('Sync failed') + ': ' + (err.message || String(err)));
                updateStatusBar();
                if (onComplete) onComplete();
            });
    }

    function doIncrementalSync(since) {
        isSyncing = true;
        updateStatusBar();
        fetchAllRules(API_URL, since)
            .then(function (result) {
                var hasNew = (result.rules.allowed.length + result.rules.disallowed.length) > 0;
                if (hasNew) mergeRules(result.rules);
                var prev     = getCacheEntry();
                var prevDate = prev ? prev.lastRecordDate : null;
                var newDate  = result.lastRecordDate;
                var bestDate = newDate
                    ? (!prevDate || new Date(newDate) > new Date(prevDate) ? newDate : prevDate)
                    : prevDate;
                saveCache(rules, bestDate);
                isSyncing = false;
                updateStatusBar();
                updateTabBadges();
            })
            .catch(function (err) {
                isSyncing = false;
                showError(window.Asc.plugin.tr('Sync failed') + ': ' + (err.message || String(err)));
                updateStatusBar();
            });
    }

    function syncRules(force, onComplete) {
        if (isSyncing) return;
        var entry = getCacheEntry();

        if (!force && entry && entry.rules) {
            rules = entry.rules;
            updateStatusBar();
            updateTabBadges();
            if (isCacheValid()) {
                if (entry.lastRecordDate) doIncrementalSync(entry.lastRecordDate);
                if (onComplete) onComplete();
            } else {
                doFullSync(onComplete);
            }
            return;
        }
        doFullSync(onComplete);
    }

    // ─────────────────────────────────────────────────────────
    // Scan logic
    // ─────────────────────────────────────────────────────────
    function escRx(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function getSnippet(text, idx, len) {
        var pad   = 55;
        var start = Math.max(0, idx - pad);
        var end   = Math.min(text.length, idx + len + pad);
        var out   = text.slice(start, end).replace(/[\r\n\t]+/g, ' ');
        if (start > 0)         out = '\u2026' + out;
        if (end < text.length) out = out + '\u2026';
        return out;
    }

    function scanText(text) {
        var allowSet = {};
        (rules.allowed || []).forEach(function (r) { allowSet[r.lower] = true; });
        var results = [], seen = {};
        (rules.disallowed || []).forEach(function (rule) {
            if (!rule.text) return;
            var re = new RegExp(escRx(rule.text), 'gi'), m;
            while ((m = re.exec(text)) !== null) {
                var lo = m[0].toLowerCase();
                if (allowSet[lo]) continue;
                var key = m.index + ':' + lo;
                if (seen[key]) continue;
                seen[key] = true;
                results.push({ matched: m[0], index: m.index, rule: rule,
                               snippet: getSnippet(text, m.index, m[0].length) });
            }
        });
        results.sort(function (a, b) { return a.index - b.index; });
        return results;
    }

    // ─────────────────────────────────────────────────────────
    // Auto-scan  — works for all editor types
    // ─────────────────────────────────────────────────────────
    function onScanDone(docText) {
        if (scanSafetyTimer) { clearTimeout(scanSafetyTimer); scanSafetyTimer = null; }
        isScanRunning = false;
        setScanIndicator(false);
        updateViolationDisplay(scanText(docText || ''));
    }

    function triggerFullScan() {
        if (isScanRunning) return;
        isScanRunning = true;
        lastScanAt    = Date.now();
        setScanIndicator(true);

        // Safety net: reset flag after 10 s if callCommand never completes
        if (scanSafetyTimer) clearTimeout(scanSafetyTimer);
        scanSafetyTimer = setTimeout(function () {
            if (isScanRunning) {
                isScanRunning = false;
                setScanIndicator(false);
                if (lastSelectedText) updateViolationDisplay(scanText(lastSelectedText));
            }
        }, 10000);

        var et = (window.Asc.plugin.info && window.Asc.plugin.info.editorType) || '';

        if (et === 'cell') {
            // ── Spreadsheet: collect all cell values across all sheets ──
            runDocCmd(function () {
                try {
                    var wb = Api.GetDocument(), parts = [];
                    var ns = wb.GetSheetsCount ? wb.GetSheetsCount() : 0;
                    for (var s = 0; s < ns; s++) {
                        var ws = wb.GetSheet(s);
                        if (!ws) continue;
                        var range = ws.GetUsedRange();
                        if (!range) continue;
                        var vals = range.GetValue();
                        if (Array.isArray(vals)) {
                            vals.forEach(function (row) {
                                var cells = Array.isArray(row) ? row : [row];
                                cells.forEach(function (v) {
                                    if (v !== null && v !== undefined && v !== '') parts.push(String(v));
                                });
                            });
                        }
                    }
                    return parts.join(' ');
                } catch (e) { return ''; }
            }, onScanDone);

        } else if (et === 'slide') {
            // ── Presentation: collect text from all shapes on all slides ──
            runDocCmd(function () {
                try {
                    var pres = Api.GetPresentation(), parts = [];
                    var ns = pres.GetSlidesCount ? pres.GetSlidesCount() : 0;
                    for (var s = 0; s < ns; s++) {
                        var slide = pres.GetSlide(s);
                        var no = slide.GetObjectsCount ? slide.GetObjectsCount() : 0;
                        for (var i = 0; i < no; i++) {
                            var shape = slide.GetObject(i);
                            if (!shape || typeof shape.GetDocContent !== 'function') continue;
                            var doc = shape.GetDocContent();
                            if (!doc) continue;
                            var np = doc.GetElementsCount ? doc.GetElementsCount() : 0;
                            for (var p = 0; p < np; p++) {
                                var para = doc.GetElement(p);
                                if (para && typeof para.GetText === 'function') parts.push(para.GetText());
                            }
                        }
                    }
                    return parts.join('\n');
                } catch (e) { return ''; }
            }, onScanDone);

        } else {
            // ── Word / PDF: iterate document paragraphs ──
            runDocCmd(function () {
                var parts = [], oDoc = Api.GetDocument(), n = oDoc.GetElementsCount();
                for (var i = 0; i < n; i++) {
                    var elem = oDoc.GetElement(i);
                    if (elem && typeof elem.GetText === 'function') parts.push(elem.GetText());
                }
                return parts.join('\n');
            }, onScanDone);
        }
    }

    function triggerSelectedScan(text) {
        if (!text || !text.trim()) return;
        updateViolationDisplay(scanText(text));
    }

    function startAutoScan() {
        triggerFullScan();
        // Interval fallback: catches edits where cursor doesn't move
        var cfg      = getConfig();
        var interval = cfg.scanIntervalMs !== undefined ? cfg.scanIntervalMs : DEFAULT_SCAN_MS;
        if (interval > 0) {
            if (scanIntervalHandle) clearInterval(scanIntervalHandle);
            scanIntervalHandle = setInterval(function () {
                if (!isScanRunning && (Date.now() - lastScanAt) > Math.max(interval - 500, 1500))
                    triggerFullScan();
            }, interval);
        }
    }

    // ─────────────────────────────────────────────────────────
    // Remove violations
    // Works in all editor types:
    //   Word/PDF  → callCommand + Api.GetDocument().SearchAndReplace
    //   Cell/Slide → executeMethod('SearchAndReplace', …)
    // ─────────────────────────────────────────────────────────
    function removeWord(word, callback) {
        if (isWordEditor()) {
            // Word must be embedded via Asc.scope — closures aren't available
            // inside callCommand because it is serialised as a string.
            window.Asc.scope        = window.Asc.scope || {};
            window.Asc.scope.cfWord = word;
            runDocCmd(function () {
                Api.GetDocument().SearchAndReplace({
                    searchString:  Asc.scope.cfWord,
                    replaceString: '',
                    matchCase:     false,
                    matchWord:     false
                });
            }, callback || function () {});
        } else {
            // Spreadsheet / presentation editors
            window.Asc.plugin.executeMethod('SearchAndReplace', [{
                searchString:  word,
                replaceString: '',
                matchCase:     false
            }], callback || function () {});
        }
    }

    function getUniqueWords(violations) {
        var seen = {}, words = [];
        violations.forEach(function (v) {
            var lo = v.matched.toLowerCase();
            if (!seen[lo]) { seen[lo] = true; words.push(v.matched); }
        });
        return words;
    }

    function removeWordsSequential(words, idx, onDone) {
        if (idx >= words.length) { if (onDone) onDone(); return; }
        removeWord(words[idx], function () { removeWordsSequential(words, idx + 1, onDone); });
    }

    function executeRemoval(violations, source) {
        var words        = getUniqueWords(violations);
        var wordsWithMeta = words.map(function (w) {
            var v = null;
            for (var i = 0; i < violations.length; i++) {
                if (violations[i].matched.toLowerCase() === w.toLowerCase()) { v = violations[i]; break; }
            }
            return { text: w, category: v ? v.rule.category : '' };
        });

        setButtonsEnabled(false);
        D.removingStatus.classList.remove('display-none');

        removeWordsSequential(words, 0, function () {
            D.removingStatus.classList.add('display-none');
            setButtonsEnabled(true);
            addToRemovalHistory(wordsWithMeta, source);
            currentViolations = [];
            updateViolationDisplay([]);
            updateTabBadges();
            // Refresh Removed tab if visible
            if (D.tabRemovedPane && !D.tabRemovedPane.classList.contains('display-none'))
                renderRemovedTab();
        });
    }

    // ─────────────────────────────────────────────────────────
    // Countdown auto-remove
    // ─────────────────────────────────────────────────────────
    function stopCountdown() {
        if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
        if (D.countdownBanner) D.countdownBanner.classList.add('display-none');
    }

    function startCountdown(violations) {
        var cfg   = getConfig();
        var delay = parseInt(cfg.autoRemoveDelay) || 0;
        if (delay <= 0 || violations.length === 0) return;
        var remaining = delay;
        D.countdownBanner.classList.remove('display-none');
        updateCountdownDisplay(remaining, delay);
        countdownInterval = setInterval(function () {
            remaining -= 1;
            if (remaining <= 0) {
                stopCountdown();
                executeRemoval(violations, 'auto');
            } else {
                updateCountdownDisplay(remaining, delay);
            }
        }, 1000);
    }

    function updateCountdownDisplay(remaining, total) {
        D.countdownText.textContent =
            window.Asc.plugin.tr('Auto-removing violations in') + ' ' + remaining + 's';
        D.countdownBar.style.width = Math.round((remaining / total) * 100) + '%';
    }

    // ─────────────────────────────────────────────────────────
    // DOM references
    // ─────────────────────────────────────────────────────────
    var D = {};
    var isDomReady = false;
    function initDom() {
        D.syncDot         = document.getElementById('sync-dot');
        D.syncStatus      = document.getElementById('sync-status');
        D.lastSync        = document.getElementById('last-sync');
        D.btnRefresh      = document.getElementById('btn-refresh');
        D.warningBar      = document.getElementById('violation-warning');
        D.warningText     = document.getElementById('warning-text');
        D.btnRemoveAll    = document.getElementById('btn-remove-all');
        D.errorMsg        = document.getElementById('error-msg');
        D.tabBar          = document.getElementById('tab-bar');
        D.badgeViol       = document.getElementById('badge-viol');
        D.badgeDis        = document.getElementById('badge-dis');
        D.badgeAll        = document.getElementById('badge-all');
        D.badgeRemoved    = document.getElementById('badge-removed');
        // Violations pane
        D.tabViolPane     = document.getElementById('tab-violations');
        D.btnScanDoc      = document.getElementById('btn-scan-doc');
        D.scanIndicator   = document.getElementById('scan-indicator');
        D.countdownBanner = document.getElementById('countdown-banner');
        D.countdownText   = document.getElementById('countdown-text');
        D.countdownBar    = document.getElementById('countdown-bar');
        D.btnCancelCD     = document.getElementById('btn-cancel-cd');
        D.removingStatus  = document.getElementById('removing-status');
        D.resultSummary   = document.getElementById('result-summary');
        D.resultsList     = document.getElementById('results-list');
        // Disallowed pane
        D.tabDisPane      = document.getElementById('tab-disallowed');
        D.searchDis       = document.getElementById('search-dis');
        D.listDis         = document.getElementById('list-dis');
        // Allowed pane
        D.tabAllPane      = document.getElementById('tab-allowed');
        D.searchAll       = document.getElementById('search-all');
        D.listAll         = document.getElementById('list-all');
        // Removed pane
        D.tabRemovedPane  = document.getElementById('tab-removed');
        D.listRemoved     = document.getElementById('list-removed');
        D.btnClearHistory = document.getElementById('btn-clear-history');
        isDomReady = true;
    }

    // ─────────────────────────────────────────────────────────
    // UI helpers
    // ─────────────────────────────────────────────────────────
    function esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    var errorTimer = null;
    function showError(msg) {
        D.errorMsg.textContent = msg;
        D.errorMsg.classList.remove('display-none');
        if (errorTimer) clearTimeout(errorTimer);
        errorTimer = setTimeout(function () { D.errorMsg.classList.add('display-none'); }, 6000);
    }

    function setButtonsEnabled(on) {
        if (D.btnRefresh)   D.btnRefresh.disabled  = !on;
        if (D.btnRemoveAll) D.btnRemoveAll.disabled = !on;
    }

    function setScanIndicator(on) {
        if (D.scanIndicator) D.scanIndicator.classList.toggle('display-none', !on);
    }

    function updateStatusBar() {
        var nA = (rules.allowed    || []).length;
        var nD = (rules.disallowed || []).length;
        var entry = getCacheEntry();

        if (isSyncing) {
            D.syncDot.className      = 'sync-dot syncing';
            D.syncStatus.textContent = window.Asc.plugin.tr('Syncing\u2026');
        } else if (nA + nD > 0) {
            D.syncDot.className      = 'sync-dot ready';
            var incrLabel = (entry && entry.lastRecordDate)
                ? ' (' + window.Asc.plugin.tr('incremental') + ')' : '';
            D.syncStatus.textContent =
                (nA + nD) + ' ' + window.Asc.plugin.tr('rules loaded') +
                ' \u2014 ' + nD + ' ' + window.Asc.plugin.tr('disallowed') +
                ', ' + nA + ' ' + window.Asc.plugin.tr('allowed') + incrLabel;
        } else {
            D.syncDot.className      = 'sync-dot idle';
            D.syncStatus.textContent = window.Asc.plugin.tr('No rules loaded. Click \u21BB to sync.');
        }

        if (entry && entry.timestamp) {
            D.lastSync.textContent =
                window.Asc.plugin.tr('Last sync') + ': ' + new Date(entry.timestamp).toLocaleString();
        } else {
            D.lastSync.textContent = window.Asc.plugin.tr('Never synced');
        }
    }

    function updateTabBadges() {
        var nD = (rules.disallowed || []).length;
        var nA = (rules.allowed    || []).length;
        var nH = getRemovalHistory().length;
        D.badgeDis.textContent     = nD;
        D.badgeAll.textContent     = nA;
        D.badgeRemoved.textContent = nH;
    }

    function updateViolationDisplay(violations) {
        currentViolations = violations;

        // Only stop the countdown when violations are gone.
        // Do NOT stop it on every scan update — initOnSelectionChanged fires on
        // every cursor move, so unconditionally stopping here caused the countdown
        // to reset to the full delay on each keystroke/cursor move.
        if (violations.length === 0) stopCountdown();

        var count = violations.length;
        D.badgeViol.textContent = count || '';
        D.badgeViol.classList.toggle('display-none', count === 0);
        D.badgeViol.classList.toggle('has-violations', count > 0);

        // Persistent warning bar (always visible when violations exist)
        if (count > 0) {
            D.warningBar.classList.remove('display-none');
            D.warningText.textContent =
                '\u26A0 ' + count + ' ' + window.Asc.plugin.tr('disallowed term(s) in document');
        } else {
            D.warningBar.classList.add('display-none');
        }

        // Render violations list
        if (violations.length === 0) {
            D.resultSummary.className = 'result-summary success';
            D.resultSummary.innerHTML =
                '<span class="summary-icon">&#10003;</span> ' +
                window.Asc.plugin.tr('No violations found');
            D.resultsList.innerHTML = '';
        } else {
            D.resultSummary.className = 'result-summary violation';
            D.resultSummary.innerHTML =
                '<span class="summary-icon">&#9888;</span> ' +
                count + '\u00a0' + window.Asc.plugin.tr('violation(s) found');

            D.resultsList.innerHTML = violations.map(function (v) {
                var catHtml = v.rule.category
                    ? '<span class="v-cat">' + esc(v.rule.category) + '</span>' : '';
                var escapedSnip = esc(v.snippet).replace(
                    new RegExp('(' + escRx(esc(v.matched)) + ')', 'gi'), '<mark>$1</mark>');
                var removeBtn = '<button class="btn-remove" data-word="' + esc(v.matched) + '">' +
                    window.Asc.plugin.tr('Remove') + '</button>';
                return '<div class="v-item">' +
                    '<div class="v-header"><span class="v-word">' + esc(v.matched) + '</span>' +
                    catHtml + removeBtn + '</div>' +
                    '<div class="v-snippet">' + escapedSnip + '</div></div>';
            }).join('');

            // Only start a fresh countdown if one isn't already ticking.
            if (!countdownInterval) startCountdown(violations);
        }
    }

    // ── Tab rendering ──────────────────────────────────────────
    function renderDisallowedTab(filter) {
        var list = rules.disallowed || [];
        if (filter) {
            var lo = filter.toLowerCase();
            list = list.filter(function (r) {
                return r.lower.indexOf(lo) !== -1 || r.category.toLowerCase().indexOf(lo) !== -1;
            });
        }
        D.listDis.innerHTML = list.length === 0
            ? '<div class="empty-state">' + window.Asc.plugin.tr('No disallowed rules loaded.') + '</div>'
            : list.map(function (r) {
                var cat = r.category ? '<span class="rule-cat">' + esc(r.category) + '</span>' : '';
                return '<div class="rule-item"><span class="rule-text">' + esc(r.text) + '</span>' + cat + '</div>';
              }).join('');
    }

    function renderAllowedTab(filter) {
        var list = rules.allowed || [];
        if (filter) {
            var lo = filter.toLowerCase();
            list = list.filter(function (r) {
                return r.lower.indexOf(lo) !== -1 || r.category.toLowerCase().indexOf(lo) !== -1;
            });
        }
        D.listAll.innerHTML = list.length === 0
            ? '<div class="empty-state">' + window.Asc.plugin.tr('No allowed rules loaded.') + '</div>'
            : list.map(function (r) {
                var cat = r.category ? '<span class="rule-cat">' + esc(r.category) + '</span>' : '';
                return '<div class="rule-item"><span class="rule-text">' + esc(r.text) + '</span>' + cat + '</div>';
              }).join('');
    }

    function renderRemovedTab() {
        var history = getRemovalHistory();
        D.badgeRemoved.textContent = history.length;
        D.listRemoved.innerHTML = history.length === 0
            ? '<div class="empty-state">' + window.Asc.plugin.tr('No removal history yet.') + '</div>'
            : history.map(function (h) {
                var cat = h.category ? '<span class="rule-cat">' + esc(h.category) + '</span>' : '';
                var src = '<span class="history-source history-source-' + esc(h.source) + '">' + esc(h.source) + '</span>';
                return '<div class="history-item">' +
                    '<div class="history-header"><span class="history-word">' + esc(h.word) + '</span>' + cat + src + '</div>' +
                    '<div class="history-meta">' + new Date(h.removedAt).toLocaleString() + '</div>' +
                '</div>';
              }).join('');
    }

    function showTab(name) {
        var btns  = D.tabBar.querySelectorAll('.tab-btn');
        var panes = document.querySelectorAll('.tab-pane');
        for (var i = 0; i < btns.length;  i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-tab') === name);
        for (var j = 0; j < panes.length; j++) panes[j].classList.toggle('display-none', panes[j].id !== 'tab-' + name);
        if (name === 'disallowed') renderDisallowedTab(D.searchDis.value);
        if (name === 'allowed')    renderAllowedTab(D.searchAll.value);
        if (name === 'removed')    renderRemovedTab();
    }

    // ─────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────
    function bindEvents() {
        D.btnRefresh.addEventListener('click', function () {
            stopCountdown();
            localStorage.removeItem(CACHE_KEY);
            rules = { allowed: [], disallowed: [] };
            doFullSync(function () { startAutoScan(); });
        });

        D.btnScanDoc.addEventListener('click', function () {
            stopCountdown();
            triggerFullScan();
        });

        D.btnRemoveAll.addEventListener('click', function () {
            stopCountdown();
            executeRemoval(currentViolations, 'manual');
        });

        D.btnCancelCD.addEventListener('click', stopCountdown);

        // Tab switching
        D.tabBar.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('.tab-btn')
                    : (e.target.classList.contains('tab-btn') ? e.target : null);
            if (btn) showTab(btn.getAttribute('data-tab'));
        });

        // Search filters
        D.searchDis.addEventListener('input', function () { renderDisallowedTab(D.searchDis.value); });
        D.searchAll.addEventListener('input', function () { renderAllowedTab(D.searchAll.value); });

        // Clear removal history
        D.btnClearHistory.addEventListener('click', function () {
            clearRemovalHistory();
            renderRemovedTab();
        });

        // Per-violation Remove button (event delegation)
        D.resultsList.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('.btn-remove')
                    : (e.target.classList.contains('btn-remove') ? e.target : null);
            if (!btn) return;
            var word = btn.getAttribute('data-word');
            if (!word) return;
            stopCountdown();
            btn.disabled = true;
            btn.textContent = '\u2026';
            // Capture category before filtering violations
            var category = '';
            for (var i = 0; i < currentViolations.length; i++) {
                if (currentViolations[i].matched.toLowerCase() === word.toLowerCase()) {
                    category = currentViolations[i].rule.category || '';
                    break;
                }
            }
            removeWord(word, function () {
                currentViolations = currentViolations.filter(function (v) {
                    return v.matched.toLowerCase() !== word.toLowerCase();
                });
                addToRemovalHistory([{ text: word, category: category }], 'manual');
                updateViolationDisplay(currentViolations);
                updateTabBadges();
            });
        });
    }

    function setupBeforeUnload() {
        window.addEventListener('beforeunload', function (e) {
            if (currentViolations.length > 0) {
                var msg = currentViolations.length +
                    ' disallowed term(s) found in document. Please remove them before closing.';
                e.returnValue = msg;
                return msg;
            }
        });
    }

    // ─────────────────────────────────────────────────────────
    // Document identity
    // Builds a stable key  "<editorType>:<sanitised-title>"  so history
    // is stored per file+product combination.
    // GetDocumentInfo is async; everything that uses currentDocId must
    // run inside the callback (startAutoScan, updateTabBadges etc.)
    // ─────────────────────────────────────────────────────────
    function initDocId(callback) {
        var et = (window.Asc.plugin.info && window.Asc.plugin.info.editorType) || 'doc';
        try {
            window.Asc.plugin.executeMethod('GetDocumentInfo', null, function (info) {
                var title = (info && (info.title || info.fileName || info.name)) || '';
                // Keep only safe chars, max 48 chars so the key stays readable
                var slug  = title.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
                currentDocId = et + ':' + (slug || 'default');
                callback();
            });
        } catch (e) {
            currentDocId = et + ':default';
            callback();
        }
    }

    // ─────────────────────────────────────────────────────────
    // Selection change handler  (called on every init after first)
    // ─────────────────────────────────────────────────────────
    function handleSelectionChange(selectedText) {
        lastSelectedText = selectedText || '';

        // ── Pass 1: immediate quick scan of the current paragraph/selection ──
        // initDataType:"text" passes the paragraph at cursor position, so this
        // gives instant feedback even before callCommand completes.
        if (lastSelectedText) {
            triggerSelectedScan(lastSelectedText);
        }

        // ── Pass 2: debounced full-document scan via callCommand ──
        // Overrides pass-1 results with complete document coverage once ready.
        if (scanDebounce) clearTimeout(scanDebounce);
        scanDebounce = setTimeout(triggerFullScan, 1500);
    }

    // ─────────────────────────────────────────────────────────
    // Plugin lifecycle
    // ─────────────────────────────────────────────────────────
    window.Asc.plugin.init = function (selectedText) {
        if (isFirstInit) {
            isFirstInit = false;
            initDom();
            bindEvents();
            setupBeforeUnload();
            // Resolve document identity first so history is correctly scoped,
            // then load rules and start scanning.
            initDocId(function () {
                syncRules(false, function () { startAutoScan(); });
            });
        } else {
            // Selection changed — debounce scan
            handleSelectionChange(selectedText || '');
        }
    };

    window.Asc.plugin.onTranslate = function () {
        if (!isDomReady) return;
        updateStatusBar();
    };

    window.Asc.plugin.onThemeChanged = function (theme) {
        window.Asc.plugin.onThemeChangedBase(theme);
        if (!isDomReady) return;
        var bg = (theme && theme['background-normal']) || '';
        document.querySelectorAll('.v-item, .rule-item, .history-item').forEach(function (el) {
            if (bg) el.style.background = bg;
        });
    };

})();
