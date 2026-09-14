/*
 * Content Filter Plugin — panel script  v1.3.0
 *
 * The reviewer's view of the organization's content policy: what the open document contains
 * that it should not, what the rules are, and what has already been taken out.
 *
 * The endpoint, the rules cache and the scan itself live in scripts/policy-core.js, shared
 * with the Content Filter Worker — the system plugin that runs with every document whether
 * this panel is open or not, and that does the highlighting and holds the save shut. When a
 * worker is broadcasting, this panel shows what the worker found and stops scanning on its
 * own; with no worker installed it scans for itself, exactly as it always did.
 *
 * Auto-scans documents for disallowed/allowed content.
 * - Event-driven: fires on every selection change (initOnSelectionChanged)
 * - Interval fallback for all editor types (catches edits without cursor moves)
 * - API: POST to Sarv Drive content-policy endpoint; headers are deploy-time constants
 * - Incremental sync: stores lastRecordDate, only fetches new records on reload
 * - Tabs: Violations | Disallowed | Allowed | Removed history
 * - Countdown auto-remove + per-violation Remove button
 * - beforeunload warning when violations exist
 * - Removal history scoped per document + editor type (50 entries per doc)
 */
(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────
    // Shared core  (scripts/policy-core.js, loaded before this file by index.html)
    //
    // The endpoint, the deployment tokens, the storage keys, the rules cache, the document
    // collectors and the scan all live there, so this panel and the worker cannot drift
    // apart. Nothing the two have in common belongs in this file.
    // ─────────────────────────────────────────────────────────
    var core = window.SarvContentPolicy;

    // The Settings view (scripts/settings.js). It reads and writes the stored settings and
    // knows the form; when to show it, and what to restart once it is saved, is this file's.
    var settings = window.SarvContentFilterSettings;

    var CACHE_KEY           = core.CACHE_KEY;
    var REMOVAL_HISTORY_KEY = core.REMOVAL_HISTORY_KEY;
    var DEFAULT_SCAN_MS     = core.DEFAULT_SCAN_MS;

    // ─────────────────────────────────────────────────────────
    // Constants  (this panel's own; nothing the user changes)
    // ─────────────────────────────────────────────────────────
    var MAX_HISTORY_PER_DOC  = 50;            // removal history kept per document
    var MAX_HISTORY_TOTAL    = 500;           // hard cap across all documents in localStorage
    var WORKER_SILENCE_MS    = 15000;         // a worker quiet for this long is treated as gone

    // ─────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────
    var rules              = core.emptyRules();
    // Which document is open - resolved async in init. Empty until then, so a message that
    // arrives first is judged on its editor type rather than against a placeholder key.
    var currentDocId       = '';
    var isSyncing          = false;
    var isScanRunning      = false;
    var isFirstInit        = true;
    var currentViolations  = [];
    var lastScanAt         = 0;
    var scanDebounce       = null;
    var countdownInterval  = null;
    var scanIntervalHandle = null;
    var lastSelectedText   = '';     // paragraph/selection text from last init() call
    var channel            = null;   // link to the worker, when one is installed
    var lastWorkerScanAt   = 0;      // when the worker last broadcast a result

    function editorType() {
        return (window.Asc.plugin.info && window.Asc.plugin.info.editorType) || '';
    }

    // Used only by removeWord to pick the right removal API per editor type.
    function isWordEditor() {
        var t = editorType();
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
    // Config & cache  (both live in the shared core)
    // ─────────────────────────────────────────────────────────
    var getConfig     = core.getConfig;
    var getCacheEntry = core.readCache;

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
    // Sync orchestration
    //
    // On every page load:
    //  1. Serve cached rules instantly (no API wait)
    //  2. Refresh in the background — the core asks only for what changed when the cache is
    //     still fresh, and refetches the lot when it is not
    //  3. After rules are ready: auto-scan starts
    //
    // A failure leaves the cached rules in force: a policy that could not be refreshed is
    // still a policy, and going quiet on a network error would be the wrong way to fail.
    // ─────────────────────────────────────────────────────────
    function syncRules(force, onComplete) {
        if (isSyncing) return;

        var entry = force ? null : getCacheEntry();
        if (entry && entry.rules) {
            rules = entry.rules;
            updateStatusBar();
            updateTabBadges();
        }

        isSyncing = true;
        updateStatusBar();

        core.syncRules(rules)
            .then(function (result) {
                rules     = result.rules;
                isSyncing = false;
                updateStatusBar();
                updateTabBadges();
                if (onComplete) onComplete();
            })
            .catch(function (err) {
                isSyncing = false;
                showError(window.Asc.plugin.tr('Sync failed') + ': ' + (err.message || String(err)));
                updateStatusBar();
                if (onComplete) onComplete();
            });
    }

    // ─────────────────────────────────────────────────────────
    // Scan logic  (the scan itself lives in the shared core)
    // ─────────────────────────────────────────────────────────
    var escRx    = core.escapeForRegExp;
    var scanText = function (text) { return core.scanText(text, rules); };

    // ─────────────────────────────────────────────────────────
    // Auto-scan  — works for all editor types
    // ─────────────────────────────────────────────────────────
    function onScanDone(docText) {
        isScanRunning = false;
        setScanIndicator(false);
        updateViolationDisplay(scanText(docText || ''));
    }

    function triggerFullScan() {
        if (isScanRunning) return;
        // Nothing to scan where a plugin cannot reach the text: the collector would answer ''
        // and this panel would then paint "no violations" over what the system worker found
        // through the editor's own search.
        if (!core.canPluginEditText(editorType())) return;
        isScanRunning = true;
        lastScanAt    = Date.now();
        setScanIndicator(true);

        // The core picks the collector for this editor and carries its own timeout, answering
        // '' rather than hanging - so the safety timer this used to need has gone with it.
        core.collectDocumentText(editorType(), 10000).then(onScanDone);
    }

    function triggerSelectedScan(text) {
        if (!text || !text.trim()) return;
        updateViolationDisplay(scanText(text));
    }

    function startAutoScan() {
        triggerFullScan();
        // Interval fallback: catches edits where the cursor doesn't move. Skipped entirely
        // while a worker is broadcasting - it is already scanning the same document, and two
        // scanners would only fight over callCommand.
        var cfg      = getConfig();
        var interval = cfg.scanIntervalMs !== undefined ? cfg.scanIntervalMs : DEFAULT_SCAN_MS;
        if (interval > 0) {
            if (scanIntervalHandle) clearInterval(scanIntervalHandle);
            scanIntervalHandle = setInterval(function () {
                if (isWorkerLive()) return;
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

    /**
     * The violations this panel can take out of the document. A word the editor's own search
     * reported carries no location (index -1) and belongs to a file whose text a plugin cannot
     * rewrite, so removal - manual or automatic - would spin forever on a call that does nothing.
     */
    function removableViolations(violations) {
        return violations.filter(function (v) { return v.index >= 0; });
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

    function executeRemoval(allViolations, source) {
        // Only what this panel can actually take out; a reported-only word (see
        // removableViolations) would otherwise be counted as removed while it is still there.
        var violations = removableViolations(allViolations);
        var remaining  = allViolations.filter(function (v) { return violations.indexOf(v) === -1; });
        if (!violations.length) return;

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
            currentViolations = remaining;
            updateViolationDisplay(remaining);
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
        // Settings pane
        D.btnSettings     = document.getElementById('btn-settings');
        D.btnSaveSettings = document.getElementById('btn-save-settings');
        D.btnClearCache   = document.getElementById('btn-clear-cache');
        D.settingsSaved   = document.getElementById('settings-saved');
        // About pane
        D.btnAbout        = document.getElementById('btn-about');
        isDomReady = true;
    }

    // ─────────────────────────────────────────────────────────
    // UI helpers
    // ─────────────────────────────────────────────────────────
    function esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    var errorTimer = null;
    var savedNoteTimer = null;
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

        // Report-only violations (a pdf, say) leave nothing for Remove all to press.
        if (D.btnRemoveAll)
            D.btnRemoveAll.disabled = removableViolations(violations).length === 0;

        // Only stop the countdown when violations are gone.
        // Do NOT stop it on every scan update — initOnSelectionChanged fires on
        // every cursor move, so unconditionally stopping here caused the countdown
        // to reset to the full delay on each keystroke/cursor move.
        if (violations.length === 0) stopCountdown();

        // One word used four times is one thing to fix, not four - and Remove takes out every
        // occurrence of it in one press - so the list, the badge and the warning all count
        // distinct words, with the number of occurrences carried on the word's own row.
        var groups      = core.groupViolations(violations);
        var count       = groups.length;
        var occurrences = violations.length;

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
                count + '\u00a0' + window.Asc.plugin.tr('disallowed term(s) found') +
                (occurrences > count
                    ? ' <span class="summary-note">' + occurrences + '\u00a0' +
                        window.Asc.plugin.tr('occurrence(s)') + '</span>'
                    : '');

            D.resultsList.innerHTML = groups.map(function (group) {
                var first   = group.occurrences[0];
                var catHtml = group.rule.category
                    ? '<span class="v-cat">' + esc(group.rule.category) + '</span>' : '';
                var cntHtml = group.count > 1
                    ? '<span class="v-count">(' + group.count + ')</span>' : '';
                // index -1 is a word the editor's own search found without handing over its
                // surroundings (see core.detectWithEditorSearch) - there is no snippet to show
                // and no text this panel could take out, so the row names the word and says
                // where the fix belongs instead of offering a button that cannot work.
                var isLocated = first.index >= 0;
                var bodyHtml  = isLocated
                    ? '<div class="v-snippet">' + esc(first.snippet).replace(
                        new RegExp('(' + escRx(esc(group.matched)) + ')', 'gi'), '<mark>$1</mark>') + '</div>'
                    : '<div class="v-snippet v-snippet-empty">' +
                        window.Asc.plugin.tr('Highlighted in the document. This file type cannot be edited here - fix it in the source file.') +
                        '</div>';
                var removeBtn = isLocated
                    ? '<button class="btn-remove" data-word="' + esc(group.matched) + '">' +
                        window.Asc.plugin.tr('Remove') + '</button>'
                    : '';
                return '<div class="v-item">' +
                    '<div class="v-header"><span class="v-word">' + esc(group.matched) + '</span>' +
                    cntHtml + catHtml + removeBtn + '</div>' + bodyHtml + '</div>';
            }).join('');

            // Only start a fresh countdown if one isn't already ticking, and only over the
            // violations that can actually be removed.
            if (!countdownInterval) startCountdown(removableViolations(violations));
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
        if (name === 'settings')   settings.populate();
    }

    // ─────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────
    function bindEvents() {
        D.btnRefresh.addEventListener('click', function () {
            stopCountdown();
            localStorage.removeItem(CACHE_KEY);
            rules = core.emptyRules();
            syncRules(true, function () { startAutoScan(); });
            // The worker holds its own copy of the rules, so it has to be told to refetch.
            publishToWorker({ type: 'rulesChanged' });
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

        // Settings and About are views of this panel, reached from the status bar. They are
        // panes like the tabs are, so showTab already knows how to put one up and take it
        // down again - a tab click leaves them the same way it leaves any other pane.
        D.btnSettings.addEventListener('click', function () { showTab('settings'); });
        D.btnAbout.addEventListener('click', function () { showTab('about'); });

        D.btnSaveSettings.addEventListener('click', function () {
            var saved = settings.save();
            // The scan loop holds the old interval, so it has to be restarted to pick the
            // new one up; saving is otherwise invisible until the panel is reopened.
            startAutoScan();
            if (!saved.autoRemoveDelay) stopCountdown();
            D.settingsSaved.classList.remove('display-none');
            if (savedNoteTimer) clearTimeout(savedNoteTimer);
            savedNoteTimer = setTimeout(function () {
                D.settingsSaved.classList.add('display-none');
            }, 3000);
        });

        D.btnClearCache.addEventListener('click', function () {
            settings.clearCache();
            updateStatusBar();
        });

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
                // Distinct words, to match what the panel and the warning bar say.
                var msg = core.groupViolations(currentViolations).length +
                    ' disallowed term(s) found in document. Please remove them before closing.';
                e.returnValue = msg;
                return msg;
            }
        });
    }

    // ─────────────────────────────────────────────────────────
    // Document identity
    //
    // Names the open document, and does it the same way the worker does - the two have to
    // agree on it, because it is also what tells this panel's worker apart from the worker of
    // whatever is open in the next tab (see core.documentKey). It scopes the removal history
    // as well, so a word taken out of a presentation is not listed under a text document.
    //
    // Resolving it is async; everything that uses currentDocId must run inside the callback
    // (startAutoScan, updateTabBadges etc.)
    // ─────────────────────────────────────────────────────────
    function initDocId(callback) {
        core.documentKey()
            .then(function (key) {
                currentDocId = key || editorType() || 'doc';
                callback();
            })
            .catch(function () {
                currentDocId = editorType() || 'doc';
                callback();
            });
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
        // Overrides pass-1 results with complete document coverage once ready. A live worker
        // is already scanning the same document, so it is asked to scan now instead.
        if (scanDebounce) clearTimeout(scanDebounce);
        scanDebounce = setTimeout(function () {
            if (isWorkerLive()) publishToWorker({ type: 'requestScan' });
            else                triggerFullScan();
        }, 1500);
    }

    // ─────────────────────────────────────────────────────────
    // Worker channel
    //
    // The Content Filter Worker is a system plugin: the editor runs it with every document,
    // open panel or not, and it is the half that highlights the words and holds the save
    // shut. It broadcasts every result it gets, so when one is present this panel displays
    // the worker's scan rather than duplicating it.
    //
    // Both halves are served from the same origin, which is what lets a BroadcastChannel
    // reach from one hidden iframe to the other. Where there is no worker - or no
    // BroadcastChannel - nothing arrives, isWorkerLive() stays false and the panel keeps
    // scanning for itself.
    // ─────────────────────────────────────────────────────────
    function isWorkerLive() {
        return (Date.now() - lastWorkerScanAt) < WORKER_SILENCE_MS;
    }

    function publishToWorker(message) {
        if (!channel || !channel.supported) return false;
        message.channel     = core.CHANNEL_NAME;
        // Stamped so only this document's worker answers - every other tab of the same origin
        // is listening on the same channel.
        message.documentKey = currentDocId;
        message.editorType  = editorType();
        return channel.publish(message);
    }

    function onWorkerMessage(message) {
        if (!message || message.channel !== core.CHANNEL_NAME) return;
        if (message.type !== 'scan') return;   // requests are the worker's to answer, not ours

        // A BroadcastChannel carries to every tab of this origin, so a result has to be checked
        // against the document it is about before it is believed. Without this a panel watching
        // a text document lists - and counts, and offers to remove - the words the presentation
        // open in the next tab happens to hold.
        if (!core.isSameDocument(currentDocId, message, editorType())) return;

        lastWorkerScanAt = Date.now();

        // The worker scanned the whole document with the same rules and the same core, so its
        // violations are this panel's violations. Its own scan is left running as the fallback
        // for the moment the worker stops answering.
        setScanIndicator(false);
        updateViolationDisplay(message.violations || []);
    }

    function initChannel() {
        channel = core.openChannel(onWorkerMessage);
        // Asks any worker already running to say what it last found, so a panel opened
        // mid-session shows the current state instead of waiting for the next scan.
        publishToWorker({ type: 'requestState' });
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
            initChannel();
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
        settings.refreshCacheInfo();
    };

})();
