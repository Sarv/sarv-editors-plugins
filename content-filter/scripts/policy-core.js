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

    /**
     * Separates the text the editor can act on from the text it cannot. Everything a collector
     * appends after this mark is text the running editor can neither highlight nor replace - a
     * spreadsheet's text boxes, whose search engine only looks at cells - so a word found there
     * is reported without a position, the same way a word the pdf engine reports is. A control
     * character no document text contains, so it can never split a word of its own accord.
     */
    const REPORT_ONLY_MARK = "\u0000";

    /** A little of the surrounding text, so a reviewer can see where a word sits. */
    const getSnippet = (text, index, length) => {
        const pad   = 55;
        const start = Math.max(0, index - pad);
        const end   = Math.min(text.length, index + length + pad);
        const body  = text.slice(start, end).replace(/[\r\n\t\u0000]+/g, " ");
        return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
    };

    /**
     * Every disallowed word present in the text, unless an allowed rule names that exact
     * word - the allow list is how an organization carves an exception out of a broad rule.
     * @returns {Array<{matched: string, index: number, rule: object, snippet: string}>}
     */
    const scanText = (text, rules) => {
        const body = text || "";

        // Where the text the editor cannot act on starts, or the end of the text when all of it
        // can be acted on.
        const markAt = body.indexOf(REPORT_ONLY_MARK);
        const reportOnlyFrom = markAt < 0 ? body.length : markAt;

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

                // A match past the mark has no position the editor can be sent to, and no
                // snippet either: index -1 is how a reported-only word is already spelt.
                const isReportOnly = match.index >= reportOnlyFrom;

                found.push({
                    matched: match[0],
                    index:   isReportOnly ? -1 : match.index,
                    rule:    rule,
                    snippet: isReportOnly ? "" : getSnippet(body, match.index, match[0].length)
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
    /**
     * The whole document, as one string, for whichever editor is running.
     *
     * This runs inside the editor via callCommand, which serialises it to a string - so it has
     * to be self-contained: no closures over anything in this file, and everything it needs
     * passed in through Asc.scope. That is also why all three editors are read by one function
     * rather than three: the helpers that read a document content, a shape or a table are the
     * same everywhere and exist here once.
     *
     * What it has to cover is set by the editor's own search engine, because the engine is what
     * highlights whatever this finds: a word this misses is a word that is neither marked nor
     * blocked. For a text document the engine walks the body, the headers and footers of every
     * section, the footnotes, the endnotes and the text inside every shape - so all of those are
     * read here too. Reading only the body's top-level paragraphs (which is all this used to do)
     * let a word inside a table, a text box, a header or a footnote save unchallenged.
     *
     * Every stage is read on its own and its failure is swallowed: a document whose footnotes
     * cannot be read still has its body scanned, which is safer than one unreadable corner
     * turning the whole scan clean.
     */
    const documentTextCollector = function () {
        // One part per region, joined with a newline, so no phrase can be formed across the
        // seam between two of them - a word in one table cell and the next word in its
        // neighbour must not read as a banned phrase.
        const parts = [];
        const add = (text) => {
            if (text !== null && text !== undefined && text !== "") parts.push(String(text));
        };

        // Text the editor can neither mark nor rewrite is kept apart and appended last, behind
        // the mark the scan looks for - see REPORT_ONLY_MARK. A word found only there is named
        // in the message that holds the save, but the panel is not offered a Remove button that
        // would do nothing.
        const reportOnly = [];
        const addReportOnly = (text) => {
            if (text !== null && text !== undefined && text !== "") reportOnly.push(String(text));
        };

        const attempt = (read) => { try { read(); } catch (error) { /* this region only */ } };

        // Numbering is left out (list numbers are not the user's words) and every separator is
        // a newline for the same reason the parts are: text from two cells, rows or paragraphs
        // must never join into a phrase that is in neither of them.
        const TEXT_OPTIONS = {
            Numbering:          false,
            Math:               true,
            TableCellSeparator: "\n",
            TableRowSeparator:  "\n",
            ParaSeparator:      "\n",
            TabSymbol:          " ",
            NewLineSeparator:   "\n"
        };

        /**
         * A document content - a body, a header, a footnote, a shape's or a cell's insides.
         * @param {object} content
         * @param {function} [sink=add] - Where the text goes: add, or addReportOnly.
         */
        const readContent = (content, sink) => {
            if (!content) return;
            const take = sink || add;

            // GetText reads the whole content in one go, tables and nested tables included.
            if (typeof content.GetText === "function") {
                take(content.GetText(TEXT_OPTIONS));
                return;
            }

            const count = typeof content.GetElementsCount === "function" ? content.GetElementsCount() : 0;
            for (let index = 0; index < count; index++) {
                const element = content.GetElement(index);
                if (element && typeof element.GetText === "function") take(element.GetText(TEXT_OPTIONS));
            }
        };

        /** The text inside every shape of a container - a document, a header, a worksheet. */
        const readShapes = (container, sink) => {
            if (!container || typeof container.GetAllShapes !== "function") return;
            container.GetAllShapes().forEach((shape) => {
                // A shape says GetDocContent, an older build says GetContent; both answer with
                // a document content of paragraphs.
                const reader = shape && (shape.GetDocContent || shape.GetContent);
                if (typeof reader === "function") attempt(() => readContent(reader.call(shape), sink));
            });
        };

        // ── a text document (and anything else built on one) ──────────────────────────
        const readTextDocument = () => {
            const doc = Api.GetDocument();
            if (!doc) return;

            attempt(() => readContent(doc));   // the body, with its tables
            attempt(() => readShapes(doc));    // text boxes and shapes anchored in the body

            // Headers and footers: three types per section, and sections commonly share one, so
            // the same text is only taken once.
            attempt(() => {
                const sections = typeof doc.GetSections === "function" ? doc.GetSections() : [];
                const seen = {};
                sections.forEach((section) => {
                    ["default", "even", "title"].forEach((type) => {
                        const contents = [
                            typeof section.GetHeader === "function" ? section.GetHeader(type, false) : null,
                            typeof section.GetFooter === "function" ? section.GetFooter(type, false) : null
                        ];
                        contents.forEach((content) => {
                            if (!content) return;
                            attempt(() => {
                                const before = parts.length;
                                readContent(content);
                                readShapes(content);
                                const text = parts.slice(before).join("\n");
                                if (seen[text]) parts.length = before;
                                else seen[text] = true;
                            });
                        });
                    });
                });
            });

            // Footnotes and endnotes. The editor lists the *first* paragraph of each note; the
            // note itself is that paragraph's parent content, which holds all of its paragraphs
            // - so one read per note covers a note of any length exactly once.
            attempt(() => {
                const firstParagraphs = [];
                if (typeof doc.GetFootnotesFirstParagraphs === "function")
                    firstParagraphs.push.apply(firstParagraphs, doc.GetFootnotesFirstParagraphs());
                if (typeof doc.GetEndNotesFirstParagraphs === "function")
                    firstParagraphs.push.apply(firstParagraphs, doc.GetEndNotesFirstParagraphs());

                firstParagraphs.forEach((paragraph) => attempt(() => {
                    const note = paragraph && paragraph.Paragraph && typeof paragraph.Paragraph.GetParent === "function"
                        ? paragraph.Paragraph.GetParent()
                        : null;
                    if (note && typeof note.GetText === "function") add(note.GetText(TEXT_OPTIONS));
                    else if (paragraph && typeof paragraph.GetText === "function") add(paragraph.GetText(TEXT_OPTIONS));
                }));
            });
        };

        // ── a presentation ────────────────────────────────────────────────────────────
        // Only the slides and their speaker notes are read, which is exactly what the engine
        // searches: GetAllShapes on the presentation would drag in every layout and master,
        // whose placeholder boilerplate is not the user's text and cannot be removed by them.
        const readPresentation = () => {
            const readDrawing = (drawing) => {
                if (!drawing) return;

                const reader = drawing.GetDocContent || drawing.GetContent;
                if (typeof reader === "function") attempt(() => readContent(reader.call(drawing)));

                // A table keeps its text in the cells, and a group in its children.
                if (typeof drawing.GetRowsCount === "function") {
                    const rowCount = drawing.GetRowsCount();
                    for (let row = 0; row < rowCount; row++) {
                        const tableRow = drawing.GetRow(row);
                        const cellCount = tableRow && tableRow.GetCellsCount ? tableRow.GetCellsCount() : 0;
                        for (let cell = 0; cell < cellCount; cell++) readDrawing(tableRow.GetCell(cell));
                    }
                } else if (typeof drawing.GetAllDrawings === "function") {
                    drawing.GetAllDrawings().forEach(readDrawing);
                }
            };

            Api.GetPresentation().GetAllSlides().forEach((slide) => {
                attempt(() => slide.GetAllDrawings().forEach(readDrawing));
                attempt(() => {
                    const notes = typeof slide.GetNotesPage === "function" ? slide.GetNotesPage() : null;
                    if (notes && typeof notes.GetBodyShapeText === "function") add(notes.GetBodyShapeText());
                });
            });
        };

        // ── a spreadsheet ─────────────────────────────────────────────────────────────
        // Api.GetDocument() answers here too, but the object it returns has no GetSheet or
        // GetSheetsCount - the sheets come from Api.GetSheets(). A used range of one cell hands
        // back a scalar rather than a grid, so both shapes are flattened.
        //
        // Text boxes are read as well, as report-only text: the spreadsheet's search engine
        // only ever looks at cells (it walks cells, not runs), so a word inside a text box can
        // be neither highlighted nor replaced from here - but it is still named in the message
        // that holds the save, which is what stops it reaching the file.
        const readWorkbook = () => {
            const sheets = Api.GetSheets ? Api.GetSheets() : [];
            for (let index = 0; index < sheets.length; index++) {
                const worksheet = sheets[index];
                if (!worksheet) continue;

                attempt(() => {
                    const range = worksheet.GetUsedRange ? worksheet.GetUsedRange() : null;
                    if (!range) return;
                    const values = range.GetValue();
                    const rows = Array.isArray(values) ? values : [values];
                    rows.forEach((row) => {
                        const cells = Array.isArray(row) ? row : [row];
                        cells.forEach(add);
                    });
                });
                attempt(() => readShapes(worksheet, addReportOnly));
            }
        };

        const readers = { cell: readWorkbook, slide: readPresentation, word: readTextDocument };
        (readers[Asc.scope.contentPolicyEditorType] || readTextDocument)();

        // The mark is REPORT_ONLY_MARK, spelt out because this function is serialised on its
        // own and can close over nothing.
        const body = parts.join("\n");
        return reportOnly.length ? body + "\u0000" + reportOnly.join("\n") : body;
    };

    /**
     * The whole document as one string. Rejects nothing: an editor that cannot be read hands
     * back an empty string, which scans clean - the pdf editor, where a plugin reaches no text
     * at all, is read by the engine's own search instead (see detectWithEditorSearch).
     * @param {string} editorType - word, cell, slide or pdf.
     * @param {number} timeoutMs - Answer empty rather than hang if callCommand never returns.
     * @returns {Promise<string>}
     */
    const collectDocumentText = (editorType, timeoutMs) => new Promise((resolve) => {
        let settled = false;

        const finish = (text) => {
            if (settled) return;
            settled = true;
            resolve(text || "");
        };

        const timer = window.setTimeout(() => finish(""), timeoutMs || 10000);

        try {
            // Which editor to read is the one thing the command needs from here, and Asc.scope
            // is the only channel into it - callCommand serialises the function itself.
            window.Asc.scope.contentPolicyEditorType = editorType || "word";

            // isClose false, isCalc false: reading the text changes nothing, and letting the
            // editor recalculate after every scan would drop the highlight this scan just
            // asked for and cost a layout pass on a large document every few seconds.
            window.Asc.plugin.callCommand(documentTextCollector, false, false, (text) => {
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

    // ── which document this half is attached to ─────────────────────────────
    /**
     * The property the id is kept on inside the editor - see instanceIdCommand.
     */
    const INSTANCE_PROPERTY = "__sarvContentPolicyInstanceId";

    /**
     * Runs inside the editor, through callCommand. A command is evaluated with window, document
     * and globalThis all shadowed by empty objects, so the editor's own Api object is the only
     * thing a command can reach that outlives the call and that both halves of this plugin share
     * - one Api per open editor. An id is minted on it the first time either half asks, and
     * every later ask, from either half, gets that same id back.
     */
    const instanceIdCommand = function () {
        const property = Asc.scope.contentPolicyInstanceProperty;
        if (!Api[property]) {
            Api[property] = "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        }
        return Api[property];
    };

    /**
     * The document key the editor itself knows, when the plugin frame can see the editor's
     * window. Both halves are served from the document server, the same origin as the editor
     * page that frames them, so this normally reads the very key the document was opened under -
     * a name that survives a reload, which a minted id cannot. A plugin frame that cannot reach
     * its parent (an isolated plugin, an opaque origin) gets nothing and the caller mints instead.
     * @returns {string}
     */
    const editorWindowDocumentId = () => {
        let frame = window;
        for (let depth = 0; depth < 3; depth += 1) {
            try {
                const parent = frame.parent;
                if (!parent || parent === frame) return "";
                frame = parent;

                const editor = frame.Asc && frame.Asc.editor;
                if (editor && editor.documentId) return String(editor.documentId);
            } catch (error) {
                return "";   // cross-origin, and every frame above it is too
            }
        }
        return "";
    };

    /**
     * Names the document this half is attached to, so a message from another one can be told
     * apart from a message about this one. A BroadcastChannel carries to every tab of the same
     * origin, so without this a panel watching a text document is handed - and believes - the
     * scan of the presentation open in the next tab.
     *
     * Asked for once: the answer cannot change while the document is open, and both halves have
     * to agree on it, which they do by resolving it exactly the same way.
     * @param {number} [timeoutMs]
     * @returns {Promise<string>}
     */
    let documentKeyPromise = null;
    const documentKey = (timeoutMs) => {
        if (documentKeyPromise) return documentKeyPromise;

        const editorType = (window.Asc && window.Asc.plugin && window.Asc.plugin.info
            && window.Asc.plugin.info.editorType) || "";

        documentKeyPromise = new Promise((resolve) => {
            const known = editorWindowDocumentId();
            if (known) {
                resolve(editorType + ":doc:" + known);
                return;
            }

            let settled = false;
            const finish = (id) => {
                if (settled) return;
                settled = true;
                // The editor type alone is the last resort: it still keeps a text document's
                // panel from listening to a presentation's worker.
                resolve(id ? editorType + ":instance:" + id : editorType);
            };

            const timer = window.setTimeout(() => finish(""), timeoutMs || 10000);

            try {
                window.Asc.scope = window.Asc.scope || {};
                window.Asc.scope.contentPolicyInstanceProperty = INSTANCE_PROPERTY;
                window.Asc.plugin.callCommand(instanceIdCommand, false, false, (id) => {
                    window.clearTimeout(timer);
                    finish(id);
                });
            } catch (error) {
                window.clearTimeout(timer);
                finish("");
            }
        });

        return documentKeyPromise;
    };

    /**
     * Whether a message that arrived on the channel is about the document this half is attached
     * to. A stamped message is believed only on a matching key - including in the moment before
     * this half has resolved its own, where nothing can confirm it belongs here. An unstamped
     * message is judged on its editor type, which at least keeps a text document apart from the
     * presentation in the next tab.
     * @param {?string} ownKey
     * @param {?object} message
     * @param {string} ownEditorType
     * @returns {boolean}
     */
    const isSameDocument = (ownKey, message, ownEditorType) => {
        if (!message) return false;
        if (message.documentKey) return ownKey === message.documentKey;
        if (ownEditorType && message.editorType) return ownEditorType === message.editorType;
        return true;
    };

    // ── what to show for what was found ───────────────────────────────────
    /**
     * One entry per disallowed word rather than one per occurrence: a word used four times is
     * one thing to fix, not four, and Remove takes out every occurrence of it in one go anyway.
     * Case is ignored when grouping - "EBITDA" and "ebitda" break the same rule - and the first
     * spelling met is the one shown.
     * @param {Array<{matched: string, index: number, rule: object, snippet: string}>} violations
     * @returns {Array<{matched: string, count: number, rule: object, occurrences: Array}>}
     */
    const groupViolations = (violations) => {
        const byWord = {};
        const groups = [];

        (violations || []).forEach((violation) => {
            const lower = String(violation.matched).toLowerCase();
            let group = byWord[lower];

            if (!group) {
                group = {
                    matched:     violation.matched,
                    rule:        violation.rule,
                    count:       0,
                    occurrences: []
                };
                byWord[lower] = group;
                groups.push(group);
            }

            group.count += 1;
            group.occurrences.push(violation);
        });

        return groups;
    };

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
        groupViolations:     groupViolations,
        documentKey:         documentKey,
        isSameDocument:      isSameDocument,

        openChannel:         openChannel
    };

})(window);
