/*
 * Content Filter — shared core
 *
 * Everything the content policy does that has nothing to do with a user interface: the rules
 * API, the rule cache, the scan, reading the document's text, and the channel the two plugins
 * talk over.
 *
 * Loaded by both halves of the feature and by nothing else:
 *   - content-filter-worker  the resident system plugin that scans, highlights and blocks saves
 *   - content-filter         the panel a reviewer opens to see and remove what was found
 *
 * No DOM, no window.Asc.plugin.tr, no state of its own beyond the deployment constants - the
 * rules are handed in and handed back so each caller owns its own copy.
 */
(function (window) {
    "use strict";

    // ── deployment configuration ───────────────────────────────────────────────────────
    // Where the rule list comes from. These are only the fallbacks, for a deployment that
    // configures nothing; the integrator normally overrides them from the editor config, so a
    // new endpoint or a rotated token does not need the plugin republished:
    //
    //   editorConfig.plugins.options = {
    //       all: {                                   // both halves of the feature at once
    //           contentPolicy: {
    //               endpoint:      "https://drive.example.com/api/get-content-policy",
    //               sessionToken:  "<the user's session token>",
    //               bearerToken:   "<the service token>",
    //               activeAccount: "0",
    //               orgId:         "acme"
    //           }
    //       }
    //   };
    //
    // The editor hands that block over as Asc.plugin.info.options on init and re-sends it
    // whenever the integrator calls setPluginsOptions, so nothing here is read until it is
    // needed - a token can be rotated mid-session. Note the editor overlays options per
    // *property*: a guid-specific `contentPolicy` replaces the one in `all` whole, it is not
    // merged field by field.
    const API_DEFAULTS = {
        endpoint:      "https://dev-console.sarv.com/drive-api/v1/external/get-content-policy",
        sessionToken:  "940aeaa25fa9fbb1d79637ac96294394dbe3c87b5cc4d08273c8e95000a8af0e7197f834e2b2f16cb8e15f3614fab2728572",
        bearerToken:   "your_token_here",   // replace with actual Bearer token
        activeAccount: "0",
        orgId:         ""                   // leave empty to infer from Session-Token
    };

    // The key the deployment block sits under, so the plugin can be configured through
    // `options.all` without its fields colliding with another plugin's.
    const OPTIONS_KEY = "contentPolicy";

    /** What the integrator configured for this plugin, or {} when nothing was passed. */
    const integratorOptions = () => {
        const info = window.Asc && window.Asc.plugin && window.Asc.plugin.info;
        return (info && info.options && info.options[OPTIONS_KEY]) || {};
    };

    /**
     * The deployment settings in force: the built-in fallbacks with the integrator's values on
     * top. An override that is absent or blank leaves the fallback alone, so a config may set
     * only the endpoint and keep everything else.
     * @returns {{endpoint: string, sessionToken: string, bearerToken: string,
     *            activeAccount: string, orgId: string}}
     */
    const apiSettings = () => {
        const overrides = integratorOptions();
        return Object.keys(API_DEFAULTS).reduce((settings, key) => {
            const value = overrides[key];
            settings[key] = (value === undefined || value === null || value === "")
                ? API_DEFAULTS[key]
                : String(value);
            return settings;
        }, {});
    };

    const CONFIG_KEY          = "CONTENT_FILTER_CONFIG";
    const CACHE_KEY           = "CONTENT_FILTER_CACHE";
    const REMOVAL_HISTORY_KEY = "CONTENT_FILTER_REMOVAL_HISTORY";

    const DEFAULT_CACHE_HRS = 24;
    const DEFAULT_SCAN_MS   = 3000;

    // Both plugins are served from the same origin, so a BroadcastChannel reaches from one
    // hidden iframe to the other without going through the editor.
    const CHANNEL_NAME = "sarv-content-filter";

    const emptyRules = () => ({ allowed: [], disallowed: [] });

    // ── config & cache (localStorage, shared by both plugins) ──────────────────────────
    const readJson = (key, fallback) => {
        try {
            return JSON.parse(window.localStorage.getItem(key)) || fallback;
        } catch (error) {
            return fallback;
        }
    };

    const writeJson = (key, value) => {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            return false;
        }
    };

    const getConfig = () => readJson(CONFIG_KEY, {});

    /** Stores the user-editable settings. The panel's Settings view is the only writer. */
    const writeConfig = (config) => writeJson(CONFIG_KEY, config);

    const readCache = () => readJson(CACHE_KEY, null);

    const isCacheFresh = (cache) => {
        if (!cache || !cache.timestamp || !cache.rules) return false;
        const ttlMs = (getConfig().cacheTtlHours || DEFAULT_CACHE_HRS) * 3600000;
        return (Date.now() - cache.timestamp) < ttlMs;
    };

    const writeCache = (rules, lastRecordDate) => {
        const entry = { timestamp: Date.now(), rules: rules };
        if (lastRecordDate) entry.lastRecordDate = lastRecordDate;
        return writeJson(CACHE_KEY, entry);
    };

    /** The rules already on this machine, so a scan can start before the API answers. */
    const loadCachedRules = () => {
        const cache = readCache();
        return {
            rules:          (cache && cache.rules) || emptyRules(),
            lastRecordDate: (cache && cache.lastRecordDate) || null,
            isFresh:        isCacheFresh(cache)
        };
    };

    // ── rules API ──────────────────────────────────────────────────────────────────────
    // Both camelCase and snake_case field names are accepted; the endpoint has answered in
    // both shapes.
    const normalizeRecord = (raw) => {
        const text = String(raw.text || raw.word || raw.phrase || raw.term || "").trim();
        if (!text) return null;

        return {
            text:     text,
            lower:    text.toLowerCase(),
            type:     String(raw.type || raw.policy_type || "disallowed").toLowerCase(),
            category: String(raw.category || raw.group || ""),
            date:     String(raw.updatedAt || raw.updated_at || raw.modifiedAt || "")
        };
    };

    const latestDate = (current, candidate) => {
        if (!candidate) return current;
        const parsed = new Date(candidate);
        if (isNaN(parsed.getTime())) return current;
        return (!current || parsed > new Date(current)) ? candidate : current;
    };

    const splitByType = (records) => ({
        allowed:    records.filter((record) => record.type === "allowed"),
        disallowed: records.filter((record) => record.type !== "allowed")
    });

    /**
     * @param {?string} since - ISO date; only records changed after it are asked for.
     * @returns {Promise<{rules: object, lastRecordDate: ?string}>}
     */
    const fetchRules = async (since) => {
        const api = apiSettings();
        const payload = { organization_id: api.orgId };
        if (since) payload.since = since;

        const userId = (window.Asc && window.Asc.plugin && window.Asc.plugin.info
            && window.Asc.plugin.info.userId) || "";
        if (userId) payload.userId = userId;

        const response = await window.fetch(api.endpoint, {
            method:  "POST",
            headers: {
                "Content-Type":   "application/json",
                "Session-Token":  api.sessionToken,
                "active-account": api.activeAccount,
                "Authorization":  "Bearer " + api.bearerToken
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error("HTTP " + response.status + " " + response.statusText);
        }

        const data = await response.json();
        // Accept a flat array or a { data | policies | rules } wrapper.
        const records = Array.isArray(data) ? data : (data.data || data.policies || data.rules || []);

        const collected = records.map(normalizeRecord).filter(Boolean);
        const lastRecordDate = collected.reduce((newest, record) => latestDate(newest, record.date), null);

        return { rules: splitByType(collected), lastRecordDate: lastRecordDate };
    };

    /** Later records win, keyed on the lower-cased text - an incremental sync overwrites. */
    const mergeRules = (base, incoming) => {
        const byText = {};
        const add = (record) => { byText[record.lower] = record; };

        (base.allowed        || []).forEach(add);
        (base.disallowed     || []).forEach(add);
        (incoming.allowed    || []).forEach(add);
        (incoming.disallowed || []).forEach(add);

        return splitByType(Object.keys(byText).map((key) => byText[key]));
    };

    /**
     * Brings the rules up to date and writes the cache. A fresh cache only asks for what
     * changed since it was written; anything else refetches the lot.
     * @param {object} currentRules - What the caller is working from right now.
     * @returns {Promise<{rules: object, lastRecordDate: ?string, mode: string}>}
     */
    const syncRules = async (currentRules) => {
        const cache = readCache();
        const since = (isCacheFresh(cache) && cache.lastRecordDate) ? cache.lastRecordDate : null;
        const result = await fetchRules(since);

        if (!since) {
            writeCache(result.rules, result.lastRecordDate);
            return { rules: result.rules, lastRecordDate: result.lastRecordDate, mode: "full" };
        }

        const merged = mergeRules(currentRules || emptyRules(), result.rules);
        const bestDate = latestDate(cache.lastRecordDate, result.lastRecordDate);
        writeCache(merged, bestDate);
        return { rules: merged, lastRecordDate: bestDate, mode: "incremental" };
    };

    // ── the scan ───────────────────────────────────────────────────────────────────────
    const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    /** A little of the surrounding text, so a reviewer can see where a word sits. */
    const getSnippet = (text, index, length) => {
        const pad   = 55;
        const start = Math.max(0, index - pad);
        const end   = Math.min(text.length, index + length + pad);
        const body  = text.slice(start, end).replace(/[\r\n\t]+/g, " ");
        return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
    };

    /**
     * Every disallowed word present in the text, unless an allowed rule names that exact
     * word - the allow list is how an organization carves an exception out of a broad rule.
     * @returns {Array<{matched: string, index: number, rule: object, snippet: string}>}
     */
    const scanText = (text, rules) => {
        const body = text || "";
        const allowed = {};
        ((rules && rules.allowed) || []).forEach((rule) => { allowed[rule.lower] = true; });

        const found = [];
        const seen  = {};

        ((rules && rules.disallowed) || []).forEach((rule) => {
            if (!rule.text) return;

            const pattern = new RegExp(escapeForRegExp(rule.text), "gi");
            let match;
            while ((match = pattern.exec(body)) !== null) {
                const lower = match[0].toLowerCase();
                if (allowed[lower]) continue;

                const key = match.index + ":" + lower;
                if (seen[key]) continue;
                seen[key] = true;

                found.push({
                    matched: match[0],
                    index:   match.index,
                    rule:    rule,
                    snippet: getSnippet(body, match.index, match[0].length)
                });
            }
        });

        return found.sort((left, right) => left.index - right.index);
    };

    /** The distinct words to highlight or remove, in the order they first appear. */
    const matchedWords = (violations) => {
        const seen = {};
        return (violations || []).reduce((words, violation) => {
            const lower = String(violation.matched).toLowerCase();
            if (!seen[lower]) {
                seen[lower] = true;
                words.push(violation.matched);
            }
            return words;
        }, []);
    };

    // ── reading the document ───────────────────────────────────────────────────────────
    // These three run inside the editor via callCommand, which serialises them to a string -
    // so each one has to be self-contained: no closures, no references to anything here.
    const collectors = {
        // Api.GetDocument() answers in the spreadsheet too, but the object it returns has no
        // GetSheet/GetSheetsCount - the sheets come from Api.GetSheets(). A used range of one
        // cell hands back a scalar rather than a grid, so both shapes are flattened here.
        cell: function () {
            try {
                const sheets = Api.GetSheets ? Api.GetSheets() : [];
                const parts = [];
                for (let sheet = 0; sheet < sheets.length; sheet++) {
                    const worksheet = sheets[sheet];
                    const range = worksheet && worksheet.GetUsedRange ? worksheet.GetUsedRange() : null;
                    if (!range) continue;
                    const values = range.GetValue();
                    const rows = Array.isArray(values) ? values : [values];
                    rows.forEach(function (row) {
                        const cells = Array.isArray(row) ? row : [row];
                        cells.forEach(function (value) {
                            if (value !== null && value !== undefined && value !== "") {
                                parts.push(String(value));
                            }
                        });
                    });
                }
                return parts.join(" ");
            } catch (error) {
                return "";
            }
        },

        // ApiSlide has no GetObjectsCount/GetObject - its contents come from GetAllDrawings(),
        // which covers shapes, images, charts and tables alike. Only the slides are read:
        // Api.GetPresentation().GetAllShapes() would drag in every layout and master, whose
        // placeholder boilerplate is not the user's text and cannot be removed by them.
        slide: function () {
            try {
                const parts = [];
                const readDrawing = function (drawing) {
                    if (!drawing) return;

                    // A shape says GetDocContent, a table cell says GetContent; both answer with
                    // a document content of paragraphs.
                    const reader = drawing.GetDocContent || drawing.GetContent;
                    if (typeof reader === "function") {
                        const content = reader.call(drawing);
                        const paragraphCount = content && content.GetElementsCount ? content.GetElementsCount() : 0;
                        for (let paragraph = 0; paragraph < paragraphCount; paragraph++) {
                            const element = content.GetElement(paragraph);
                            if (element && typeof element.GetText === "function") parts.push(element.GetText());
                        }
                    }

                    // A table keeps its text in the cells, and a group in its children.
                    if (typeof drawing.GetRowsCount === "function") {
                        const rowCount = drawing.GetRowsCount();
                        for (let row = 0; row < rowCount; row++) {
                            const tableRow = drawing.GetRow(row);
                            const cellCount = tableRow && tableRow.GetCellsCount ? tableRow.GetCellsCount() : 0;
                            for (let cell = 0; cell < cellCount; cell++) {
                                readDrawing(tableRow.GetCell(cell));
                            }
                        }
                    } else if (typeof drawing.GetAllDrawings === "function") {
                        drawing.GetAllDrawings().forEach(readDrawing);
                    }
                };

                Api.GetPresentation().GetAllSlides().forEach(function (slide) {
                    slide.GetAllDrawings().forEach(readDrawing);
                });
                return parts.join("\n");
            } catch (error) {
                return "";
            }
        },

        // Word and pdf both hand back a document of paragraphs.
        word: function () {
            try {
                const doc = Api.GetDocument();
                const parts = [];
                const count = doc.GetElementsCount();
                for (let index = 0; index < count; index++) {
                    const element = doc.GetElement(index);
                    if (element && typeof element.GetText === "function") parts.push(element.GetText());
                }
                return parts.join("\n");
            } catch (error) {
                return "";
            }
        }
    };

    /**
     * The whole document as one string. Rejects nothing: an editor that cannot be read hands
     * back an empty string, which scans clean.
     * @param {string} editorType - word, cell, slide or pdf.
     * @param {number} timeoutMs - Answer empty rather than hang if callCommand never returns.
     * @returns {Promise<string>}
     */
    const collectDocumentText = (editorType, timeoutMs) => new Promise((resolve) => {
        const collector = collectors[editorType] || collectors.word;
        let settled = false;

        const finish = (text) => {
            if (settled) return;
            settled = true;
            resolve(text || "");
        };

        const timer = window.setTimeout(() => finish(""), timeoutMs || 10000);

        try {
            window.Asc.plugin.callCommand(collector, undefined, undefined, (text) => {
                window.clearTimeout(timer);
                finish(text);
            });
        } catch (error) {
            window.clearTimeout(timer);
            finish("");
        }
    });

    // ── reading the document the editor's own way ─────────────────────────────────────
    /**
     * The disallowed terms the editor's own search engine finds, highlighting them on the way.
     * The pdf editor is the reason this exists: its builder API exposes page text nowhere (a
     * page answers only GetPage/GetAllAnnots/GetAllWidgets, and RecognizeContent would rewrite
     * the document), while the engine underneath searches static pdf text perfectly well. The
     * answer carries no snippets - the engine reports which terms matched, not their
     * surroundings - so the panel still reads the text itself where it can.
     * @param {{disallowed: Array}} rules
     * @param {number} timeoutMs
     * @returns {Promise<Array<{matched: string, index: number, rule: object, snippet: string}>>}
     */
    const detectWithEditorSearch = (rules, timeoutMs) => new Promise((resolve) => {
        const byLower = {};
        const terms   = [];
        ((rules && rules.disallowed) || []).forEach((rule) => {
            if (!rule.text || byLower[rule.lower]) return;
            byLower[rule.lower] = rule;
            terms.push(rule.text);
        });

        const allowed = {};
        ((rules && rules.allowed) || []).forEach((rule) => { allowed[rule.lower] = true; });

        if (!terms.length) {
            resolve([]);
            return;
        }

        let settled = false;
        const finish = (matched) => {
            if (settled) return;
            settled = true;
            resolve((matched || []).reduce((violations, term) => {
                const lower = String(term).toLowerCase();
                if (allowed[lower] || !byLower[lower]) return violations;
                violations.push({ matched: term, index: -1, rule: byLower[lower], snippet: "" });
                return violations;
            }, []));
        };

        const timer = window.setTimeout(() => finish([]), timeoutMs || 10000);

        try {
            window.Asc.plugin.executeMethod("HighlightTerms", [terms, { matchCase: false, wholeWords: false }],
                (result) => {
                    window.clearTimeout(timer);
                    finish(result && result.matched);
                });
        } catch (error) {
            window.clearTimeout(timer);
            finish([]);
        }
    });

    /**
     * Whether a plugin can reach this editor's text at all. The pdf editor cannot: its page text
     * is exposed through neither the builder API (ApiPage offers annotations, widgets and a
     * selection, never the text) nor an edit, so a violation there can only be *reported* - by
     * the system worker, through the editor's own search - and it is the source file that has to
     * be fixed. Everywhere else the text can be both read and rewritten.
     * @param {string} editorType
     * @returns {boolean}
     */
    const canPluginEditText = (editorType) => editorType !== "pdf";

    // ── the channel between the two plugins ────────────────────────────────────────────
    /**
     * A BroadcastChannel when the browser has one, and a no-op that reports itself unusable
     * when it does not - so each side can fall back to working on its own.
     */
    const openChannel = (onMessage) => {
        if (typeof window.BroadcastChannel !== "function") {
            return { supported: false, publish: () => false, close: () => {} };
        }

        const channel = new window.BroadcastChannel(CHANNEL_NAME);
        if (onMessage) {
            channel.onmessage = (event) => {
                try {
                    onMessage(event.data);
                } catch (error) {
                    // A listener throwing must not take the channel down with it.
                }
            };
        }

        return {
            supported: true,
            publish:   (message) => {
                try {
                    channel.postMessage(message);
                    return true;
                } catch (error) {
                    return false;
                }
            },
            close: () => {
                try {
                    channel.close();
                } catch (error) { /* already closed */ }
            }
        };
    };

    window.SarvContentPolicy = {
        CONFIG_KEY:          CONFIG_KEY,
        CACHE_KEY:           CACHE_KEY,
        REMOVAL_HISTORY_KEY: REMOVAL_HISTORY_KEY,
        CHANNEL_NAME:        CHANNEL_NAME,
        DEFAULT_CACHE_HRS:   DEFAULT_CACHE_HRS,
        DEFAULT_SCAN_MS:     DEFAULT_SCAN_MS,

        OPTIONS_KEY:         OPTIONS_KEY,

        emptyRules:          emptyRules,
        apiSettings:         apiSettings,
        getConfig:           getConfig,
        writeConfig:         writeConfig,
        readCache:           readCache,
        isCacheFresh:        isCacheFresh,
        writeCache:          writeCache,
        loadCachedRules:     loadCachedRules,

        normalizeRecord:     normalizeRecord,
        fetchRules:          fetchRules,
        mergeRules:          mergeRules,
        syncRules:           syncRules,

        scanText:            scanText,
        getSnippet:          getSnippet,
        escapeForRegExp:     escapeForRegExp,
        matchedWords:        matchedWords,
        collectDocumentText: collectDocumentText,
        detectWithEditorSearch: detectWithEditorSearch,
        canPluginEditText:   canPluginEditText,

        openChannel:         openChannel
    };

})(window);
