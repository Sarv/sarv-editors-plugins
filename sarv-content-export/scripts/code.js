/**
 * Sarv Content Export - background worker
 *
 * Registered as a system plugin with isVisual:false, so the editor loads it into a
 * hidden iframe at document-open time and it never draws anything. Its only job is to
 * hand the document's content to the page that embeds the editor, on demand, as either
 * HTML or Markdown.
 *
 * ── Why postMessage and not the plugin/integrator API ───────────────────────────────
 * The host page and the editor are different origins (a harness on :4000 embedding the
 * document server on :9980), so the host cannot reach into Asc.editor. The documented
 * integrator->plugin channel (onExternalPluginMessage) is gated on the commercial
 * `advancedApi` license flag - editorscommon.js bails out when
 * `licenseResult['advancedApi']` is falsy - so it is unusable on this build.
 *
 * This plugin runs inside a plain, un-sandboxed iframe that the editor appends to its own
 * body (see plugins.js `createPluginFrame`), so `window.top` is the host page. We announce
 * ourselves upward with postMessage; the host keeps the `event.source` window handle from
 * that announcement and talks back to it directly. No license flag, no fork patch.
 *
 * ── Protocol ────────────────────────────────────────────────────────────────────────
 *   plugin -> host : {channel, type:"ready",    guid, editor, settings}
 *                    {channel, type:"result",   requestId, ok:true, format, escape, content, meta}
 *                    {channel, type:"error",    requestId, ok:false, message}
 *                    {channel, type:"settings", settings}
 *   host -> plugin : {channel, type:"ack"}                       stops the ready beacon
 *                    {channel, type:"extract",     requestId, format?, markup?, escape?, options?}
 *                    {channel, type:"getSettings", requestId?}
 *                    {channel, type:"setSettings", requestId?, settings}
 *                    {channel, type:"openSettings"}              opens the settings window
 */
(function (window, undefined) {
    "use strict";

    var CHANNEL      = "sarv-content-export";
    var SETTINGS_KEY = "sarv-content-export.settings";

    // Format, markup and escape are the user-facing settings; the rest tune the
    // Markdown/HTML converter and mirror the ConvertDocument signature in
    // apiBase_plugins.js.
    var DEFAULT_SETTINGS = {
        format:         "html",   // "html" | "markdown"
        markup:         "clean",  // "clean" | "full"  - see cleanFragment
        escape:         "none",   // "none" | "json" | "entities" - see applyEscape
        base64img:      true,     // embed images instead of emitting broken relative links
        htmlHeadings:   false,
        demoteHeadings: false,
        renderHTMLTags: false,
        frame:          false     // wrap the HTML in the document's own page box
    };

    var READY_BEACON_MS    = 1000;
    var READY_BEACON_LIMIT = 60;   // ~1 min of announcing, then give up

    var settings      = null;
    var hostWindow    = null;      // whoever acknowledged us
    var readyTimer    = null;
    var readyAttempts = 0;
    var settingsWindow = null;

    // ── settings persistence ────────────────────────────────────────────────────────
    // localStorage of the plugin's own origin, so the choice survives reloads and is not
    // entangled with the host page or the document.

    function readSettings() {
        var stored = {};
        try {
            stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY)) || {};
        } catch (e) {
            stored = {};
        }
        return normalizeSettings(stored);
    }

    function writeSettings(next) {
        settings = normalizeSettings(next);
        try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) { /* private mode - keep the in-memory copy */ }
        return settings;
    }

    function normalizeSettings(raw) {
        var source = raw || {};
        var merged = Object.keys(DEFAULT_SETTINGS).reduce(function (acc, key) {
            acc[key] = (source[key] === undefined) ? DEFAULT_SETTINGS[key] : source[key];
            return acc;
        }, {});
        merged.format = normalizeFormat(merged.format);
        merged.markup = normalizeMarkup(merged.markup);
        merged.escape = normalizeEscape(merged.escape);
        return merged;
    }

    // "md", "markdown" and "html" are all things a caller will plausibly send.
    function normalizeFormat(value) {
        var name = String(value || "").toLowerCase();
        return (name === "md" || name === "markdown") ? "markdown" : "html";
    }

    function normalizeMarkup(value) {
        var name = String(value || "").toLowerCase();
        return (name === "full" || name === "raw") ? "full" : "clean";
    }

    // A caller thinking in terms of its payload says "json"; one thinking in terms of the
    // markup says "entities" or "html". Anything else means hand the content over as it is.
    function normalizeEscape(value) {
        if (value === true) return "json";
        var name = String(value || "").toLowerCase();
        if (name === "json") return "json";
        if (name === "entities" || name === "entity" || name === "html") return "entities";
        return "none";
    }

    // ── editor API helpers ──────────────────────────────────────────────────────────

    function callMethod(name, params) {
        return new Promise(function (resolve) {
            window.Asc.plugin.executeMethod(name, params || [], resolve);
        });
    }

    function callCommand(func) {
        return new Promise(function (resolve) {
            window.Asc.plugin.callCommand(func, false, true, resolve);
        });
    }

    // ── extraction ──────────────────────────────────────────────────────────────────

    /**
     * Whole-document HTML at the highest fidelity this build offers.
     *
     * GetFileHTML -> Api.ContentToHTML(), which selects the whole document and runs it
     * through the clipboard pipeline (asc_CheckCopy format 2). That is the same producer
     * as a copy-paste into a browser, so every run keeps its inline font-family,
     * font-size, colour, weight and paragraph alignment, and images come back as base64.
     *
     * ConvertDocument("html") is the Markdown converter's HTML mode - clean and semantic
     * but it drops almost all of the character formatting - so it is only the fallback
     * for editors that have no GetFileHTML (it is defined in word/api_plugins.js only).
     */
    /**
     * GetFileHTML runs the document through the clipboard pipeline, so the fragment carries
     * the editor's own binary round-trip payload in a class="docData;DOCY;..." attribute on
     * the first element. It is several KB of base64 that means nothing outside the editor,
     * and it lands in the host's DOM as a bogus class name - so drop it, the same way the
     * editor itself strips classes before handing html to a plugin (plugins.js, EPluginDataType.html).
     */
    function stripDocData(html) {
        return html.replace(/\s*class="docData;[^"]*"/g, "");
    }

    /**
     * GetFileHTML installs a CDocumentReaderMode before it copies (word/api.js,
     * ContentToHTML), and reader mode deliberately DAMPS every font size towards the
     * reading default instead of reporting it:
     *
     *     em = (1 + pt / 12) / 2      (wordcopypaste.js, CorrectFontSize)
     *
     * so 10pt arrives as 0.91em and a 20pt heading as 1.33em - the document's size
     * contrast is squashed to half. Invert it and put real points back:
     *
     *     pt = 12 * (2 * em - 1)
     *
     * The em value is truncated to two decimals, which leaves a 0.24pt window; document
     * font sizes are multiples of 0.5pt, so re-centre inside the window and snap.
     */
    var READER_DEFAULT_PT = 12;

    function unreaderFontSizes(html) {
        return html.replace(/font-size:\s*([0-9.]+)em/g, function (match, value) {
            var em = parseFloat(value);
            if (!isFinite(em)) return match;
            var points = READER_DEFAULT_PT * (2 * (em + 0.005) - 1);
            if (!(points > 0)) return match;
            return "font-size:" + (Math.round(points * 2) / 2) + "pt";
        });
    }

    /**
     * Two things the copy pipeline drops, both recoverable from the model.
     *
     * 1. Table width. CopyTable/CopyCell (wordcopypaste.js) writes every <td> its grid
     *    width but never writes the TABLE its own width, so a table the document sizes as
     *    a percentage of the text column - Word's default "AutoFit to window", tblW pct
     *    5000 - arrives as a bare <table> and the browser shrink-wraps it to the sum of
     *    its grid, often a third of its real width.
     *
     * 2. Image wrapping. CopyParaItem's para_Drawing branch emits nothing but
     *    <img style="max-width:100%" width height src>, identical for an inline picture
     *    and for one anchored beside the text. Every floating image therefore lands in
     *    normal flow and pushes the text that used to sit next to it underneath.
     *
     * Both walks - GetAllTables and GetAllDrawingObjects - visit the document in the same
     * order the tags appear (depth first, parent before nested), so index i matches the
     * i-th tag. If a count disagrees we are looking at something we did not predict, and
     * that group is left exactly as the pipeline produced it.
     */
    function readLayout() {
        return callCommand(function () {
            var TYPE_MM = 0x01, TYPE_PCT = 0x03;
            var WRAP_NONE = 0x00, WRAP_TOP_AND_BOTTOM = 0x04;
            var ALIGN_CENTER = 0x00, ALIGN_LEFT = 0x02, ALIGN_RIGHT = 0x04;
            // Narrower than this and the space beside the picture cannot hold a word, so
            // there is no text on that side to wrap.
            var MIN_TEXT_MM = 12;

            var layout = { tables: [], drawings: [] };
            var document = Api.GetDocument();

            try {
                var tables = document.GetAllTables();
                for (var t = 0; t < tables.length; t++) {
                    var measure = tables[t].Table.Get_CompiledPr(false).TablePr.TableW;
                    if (!measure || !(measure.W > 0))       layout.tables.push(null);
                    else if (measure.Type === TYPE_PCT)     layout.tables.push(measure.W + "%");
                    else if (measure.Type === TYPE_MM)      layout.tables.push((measure.W * 72 / 25.4) + "pt");
                    else                                    layout.tables.push(null);
                }
            } catch (e) {
                layout.tables = [];
            }

            try {
                var logic = document.Document;
                var drawings = document.GetAllDrawingObjects();
                for (var d = 0; d < drawings.length; d++) {
                    // ApiDrawing wraps the graphic object; its .parent is the ParaDrawing,
                    // which is where the anchor lives.
                    var graphic = drawings[d].Drawing;
                    var anchor  = graphic && graphic.parent;
                    if (!anchor || typeof anchor.Is_Inline !== "function" || anchor.Is_Inline()) {
                        layout.drawings.push(null);
                        continue;
                    }

                    var wrap = anchor.wrappingType;
                    var distance = anchor.Distance || { T: 0, R: 0, B: 0, L: 0 };
                    var side = null, offset = 0;

                    // "Behind"/"in front of" text (none) and top-and-bottom do not wrap, so
                    // they stay in flow; only the square/tight/through family floats.
                    if (wrap !== WRAP_NONE && wrap !== WRAP_TOP_AND_BOTTOM) {
                        // How much of the text column is left free on either side of the
                        // picture, which is both what decides where the text can go and
                        // what has to become the outer margin if the picture is to stay
                        // where the document put it.
                        var fields   = logic.Get_PageFields(anchor.PageNum);
                        var gapLeft  = anchor.X - fields.X;
                        var gapRight = fields.XLimit - (anchor.X + anchor.Extent.W);
                        if (!(gapLeft > 0))  gapLeft = 0;
                        if (!(gapRight > 0)) gapRight = 0;

                        var align = (anchor.PositionH && anchor.PositionH.Align) ? anchor.PositionH.Value : null;
                        if (align === ALIGN_LEFT) {
                            side = "left";
                        } else if (align === ALIGN_RIGHT || align === ALIGN_CENTER) {
                            side = "right";
                        } else {
                            // Word wraps on both sides, which no float can do, so the side
                            // that matters is the one the text actually lands on. Lines fill
                            // from the left, so text takes the left gap whenever it is wide
                            // enough to hold any - meaning the picture behaves as a right
                            // float. Only a picture sitting against the left margin, with no
                            // usable room beside it, reads as a left float.
                            side = (gapLeft > MIN_TEXT_MM) ? "right" : "left";
                        }
                        offset = (side === "right") ? gapRight : gapLeft;
                    }

                    layout.drawings.push({
                        side:   side,
                        offset: offset,
                        block:  wrap === WRAP_TOP_AND_BOTTOM,
                        top:    distance.T,
                        right:  distance.R,
                        bottom: distance.B,
                        left:   distance.L
                    });
                }
            } catch (e) {
                layout.drawings = [];
            }

            return layout;
        }).then(function (layout) {
            return {
                tables:   (layout && Array.isArray(layout.tables))   ? layout.tables   : [],
                drawings: (layout && Array.isArray(layout.drawings)) ? layout.drawings : []
            };
        }).catch(function () {
            return { tables: [], drawings: [] };
        });
    }

    function mm(value) {
        return (Math.round(value * 72 / 25.4 * 100) / 100) + "pt";
    }

    function addStyle(tag, name, declarations) {
        if (!declarations.length) return tag;
        var css = declarations.join(";") + ";";
        if (/\bstyle\s*=\s*"/i.test(tag)) {
            return tag.replace(/\bstyle\s*=\s*"/i, 'style="' + css);
        }
        return tag.replace(new RegExp("^<" + name + "\\b"), "<" + name + ' style="' + css + '"');
    }

    function applyTableWidths(html, widths) {
        if (!widths.length) return html;
        var tags = html.match(/<table\b/gi);
        if (!tags || tags.length !== widths.length) return html;

        var index = -1;
        return html.replace(/<table\b[^>]*>/gi, function (tag) {
            index += 1;
            var width = widths[index];
            if (!width || /\bstyle\s*=\s*"[^"]*[^-]width\s*:/i.test(tag)) return tag;
            return addStyle(tag, "table", ["width:" + width]);
        });
    }

    function applyDrawingLayouts(html, drawings) {
        if (!drawings.length) return html;
        var tags = html.match(/<img\b/gi);
        if (!tags || tags.length !== drawings.length) return html;

        var index = -1;
        return html.replace(/<img\b[^>]*>/gi, function (tag) {
            index += 1;
            var layout = drawings[index];
            if (!layout || (!layout.side && !layout.block)) return tag;

            var declarations = [];
            var marginLeft  = layout.left;
            var marginRight = layout.right;

            if (layout.side) {
                declarations.push("float:" + layout.side);
                // The outer margin restores the horizontal offset the anchor had, so the
                // picture keeps its place in the column instead of jumping to the edge;
                // the inner one is Word's own distance from the picture to the text.
                if (layout.side === "right") marginRight = layout.offset;
                else                         marginLeft  = layout.offset;
            }
            if (layout.block) declarations.push("display:block", "clear:both");

            declarations.push("margin:" + mm(layout.top) + " " + mm(marginRight) + " " +
                              mm(layout.bottom) + " " + mm(marginLeft));
            return addStyle(tag, "img", declarations);
        });
    }

    function extractHtml(options) {
        return callMethod("GetFileHTML").then(function (html) {
            if (typeof html === "string" && html.length > 0) {
                var cleaned = unreaderFontSizes(stripDocData(html));
                if (cleaned.indexOf("<table") === -1 && cleaned.indexOf("<img") === -1) {
                    return { content: cleaned, source: "GetFileHTML" };
                }
                return readLayout().then(function (layout) {
                    var repaired = applyTableWidths(cleaned, layout.tables);
                    return {
                        content: applyDrawingLayouts(repaired, layout.drawings),
                        source: "GetFileHTML"
                    };
                });
            }
            return callMethod("ConvertDocument", [
                "html", options.htmlHeadings, options.base64img,
                options.demoteHeadings, options.renderHTMLTags
            ]).then(function (fallback) {
                return { content: fallback || "", source: "ConvertDocument" };
            });
        });
    }

    function extractMarkdown(options) {
        return callMethod("ConvertDocument", [
            "markdown", options.htmlHeadings, options.base64img,
            options.demoteHeadings, options.renderHTMLTags
        ]).then(function (markdown) {
            return { content: markdown || "", source: "ConvertDocument" };
        });
    }

    /**
     * Page geometry and document defaults, so the host can render the fragment inside a
     * container that matches the real page instead of inheriting its own stylesheet.
     * Everything is optional - a spreadsheet or a slide deck has no ApiDocument at all.
     */
    function readDocumentMeta() {
        return callCommand(function () {
            var meta = {};
            try {
                var doc = Api.GetDocument();
                var section = doc.GetFinalSection();
                if (section) {
                    meta.pageWidth    = section.GetPageWidth();
                    meta.pageHeight   = section.GetPageHeight();
                    meta.marginLeft   = section.GetPageMarginLeft();
                    meta.marginRight  = section.GetPageMarginRight();
                    meta.marginTop    = section.GetPageMarginTop();
                    meta.marginBottom = section.GetPageMarginBottom();
                }
                var textPr = doc.GetDefaultTextPr();
                if (textPr) {
                    meta.fontFamily   = textPr.GetFontFamily();
                    meta.fontHalfPt   = textPr.GetFontSize();
                }
            } catch (e) {
                meta.unavailable = true;
            }
            return meta;
        }).then(function (meta) {
            return meta || {};
        }).catch(function () {
            return {};
        });
    }

    // Builder lengths are twips (1/20 pt); the web wants px at 96dpi.
    function twipsToPx(twips) {
        return Math.round((Number(twips) / 20) * (96 / 72) * 100) / 100;
    }

    /**
     * The page the content came from, as inline declarations for one wrapper element:
     * real page width, real margins, the document's default font.
     *
     * This is the part the stock HTML plugin has no answer for - it hands over a bare
     * fragment, and dropping that into an arbitrary <div> is where "formatting is not
     * preserved" actually comes from: the inline styles survive, the page context does not.
     */
    function pageBoxDeclarations(meta) {
        var hasGeometry = typeof meta.pageWidth === "number" && meta.pageWidth > 0;

        var widthPx   = hasGeometry ? twipsToPx(meta.pageWidth)    : 816;
        var padLeft   = hasGeometry ? twipsToPx(meta.marginLeft)   : 96;
        var padRight  = hasGeometry ? twipsToPx(meta.marginRight)  : 96;
        var padTop    = hasGeometry ? twipsToPx(meta.marginTop)    : 96;
        var padBottom = hasGeometry ? twipsToPx(meta.marginBottom) : 96;

        var fontFamily = meta.fontFamily ? "'" + String(meta.fontFamily).replace(/'/g, "") + "'" : "'Times New Roman'";
        var fontSize   = (typeof meta.fontHalfPt === "number" && meta.fontHalfPt > 0)
            ? (meta.fontHalfPt / 2) + "pt"
            : "11pt";

        /* CSS 2.1 has no box-sizing, so the box is built the way CSS 2.1 measures one:
           `width` is the CONTENT width - the page less its two side margins - and the
           padding is added outside it, which comes to the real page width either way.
           Writing the full page width here instead would overshoot it by both margins. */
        var contentPx = Math.round((widthPx - padLeft - padRight) * 100) / 100;

        return [
            "width:" + (contentPx > 0 ? contentPx : widthPx) + "px",
            "max-width:100%",
            "margin:0 auto",
            "padding:" + padTop + "px " + padRight + "px " + padBottom + "px " + padLeft + "px",
            "background:#ffffff",
            "color:#000000",
            "font-family:" + fontFamily + ", serif",
            "font-size:" + fontSize,
            /* line-height inherits, so declaring it on the wrapper is enough for the
               whole fragment. There is no CSS 2.1 spelling for overflow-wrap, so a long
               unbroken word is left to the renderer rather than bringing CSS3 in. */
            "line-height:normal",
            "text-align:left"
        ];
    }

    /**
     * Defaults every element in the fragment needs, so the content is self-contained and no
     * separate stylesheet has to travel with it. Written as inline declarations placed
     * *before* whatever the copy pipeline already wrote, so the document's own values win.
     *
     * The fragment carries its own inline spacing, so any host defaults for these elements
     * are noise that shifts every paragraph - zero them and let the inline styles work.
     */
    /* Every declaration below is CSS 2.1, as is everything applyDrawingLayouts and
       applyTableWidths write - see the CSS 2.1 gate above for why that matters. */
    function elementDefaults() {
        var map = {};
        var add = function (names, declarations) {
            names.forEach(function (name) {
                map[name] = (map[name] || []).concat(declarations);
            });
        };

        add(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "blockquote", "pre"],
            ["margin:0", "padding:0", "font:inherit", "color:inherit"]);
        /* Every <li> from the copy pipeline wraps its text in a <p>, and a <p> is a block:
           with list-style-position:inside the marker has to take a line box of its own and
           the text drops to the next line, so every bullet and number ends up orphaned above
           its item. Hanging the marker outside - which is also what the document does - puts
           it back beside the first line. The indent itself comes over as an inline
           padding-left on the <ul>/<ol>, so leave that alone. */
        add(["li"], ["list-style-position:outside"]);
        add(["b", "strong"], ["font-weight:bold"]);
        add(["i", "em"], ["font-style:italic"]);
        add(["img"], ["max-width:100%", "height:auto"]);
        add(["table"], ["border-collapse:collapse"]);
        add(["td", "th"], ["vertical-align:top"]);
        add(["a"], ["color:inherit"]);

        return map;
    }

    var DEFAULTED_TAGS = /<(p|h[1-6]|ul|ol|li|table|td|th|blockquote|pre|img|b|strong|i|em|a)\b[^>]*>/gi;

    // A default the tag already declares itself would be dead weight in the style attribute.
    function undeclared(tag, declarations) {
        var existing = /\bstyle\s*=\s*"([^"]*)"/i.exec(tag);
        if (!existing) return declarations;
        return declarations.filter(function (declaration) {
            var property = declaration.split(":")[0];
            return !new RegExp("(^|;)\\s*" + property + "\\s*:", "i").test(existing[1]);
        });
    }

    function inlineElementDefaults(html) {
        var defaults = elementDefaults();
        return html.replace(DEFAULTED_TAGS, function (tag, name) {
            return addStyle(tag, name, undeclared(tag, defaults[name.toLowerCase()] || []));
        });
    }

    /**
     * A paragraph that is empty in the document still comes over as an empty <p> (or a <p>
     * holding an empty <span>), which has no line box and therefore no height in a browser -
     * so every blank line in the document silently vanishes. A zero-width space gives it
     * back its line.
     */
    function fillEmptyParagraphs(html) {
        return html
            .replace(/(<p\b[^>]*>)(\s*)(<\/p>)/gi, "$1&#8203;$3")
            .replace(/(<p\b[^>]*>\s*<span\b[^>]*>)(\s*)(<\/span>\s*<\/p>)/gi, "$1&#8203;$3");
    }

    /**
     * The fragment inside its page box. The trailing clear is not decoration: a wrapped
     * image is a float, so without it the page box ends at the last line of text and any
     * picture taller than it hangs out the bottom.
     */
    function wrapInPage(html, meta) {
        return '<div style="' + pageBoxDeclarations(meta).join(";") + '">' +
               html +
               '<div style="clear:both"></div>' +
               "</div>";
    }

    // Everything the page context needs, folded into the markup itself.
    function selfContainedHtml(html, meta) {
        return wrapInPage(fillEmptyParagraphs(inlineElementDefaults(html)), meta);
    }

    /**
     * ── clean markup ────────────────────────────────────────────────────────────────
     *
     * GetFileHTML is the clipboard producer, so what comes back is Word's own paste
     * payload rather than anything a host page would want to store: every tag carries the
     * editor's bookkeeping (mso-border-left-alt, mso-style-textfill-fill-color), bold and
     * italic arrive as presentational <b>/<i>, and each paragraph repeats the zeroed
     * margins and borders that only exist to defeat a host stylesheet. A one-page document
     * arrives as ~300 KB of it.
     *
     * The clean pass keeps what the document actually says - font, size, colour,
     * alignment, paragraph spacing, and the table and image geometry readLayout repaired
     * above - and drops the rest:
     *
     *   <p style="margin:0;padding:0;font:inherit;color:inherit;text-align:center;
     *      margin-top:0pt;border:none;mso-border-left-alt:none;...">
     *     <span style="font-family:'Noto Sans';mso-style-textfill-fill-color:#000000">
     *       <b style="font-weight:bold;">Hi</b></span></p>
     *
     *   -> <p style="text-align: center;">
     *        <span style="font-family: &quot;Noto Sans&quot;;"><strong>Hi</strong></span></p>
     *
     * It runs over a parsed document rather than regular expressions, for three reasons the
     * string form cannot cover: unwrapping an element that lost its last attribute needs its
     * matching close tag; the browser's CSS parser discards every mso-* declaration for free,
     * because they are not real properties and so never reach the CSSStyleDeclaration at all;
     * and it expands the shorthands (`font:inherit`, `border:none`, `margin:0`) into longhands,
     * which is what makes one flat allow-list able to decide the whole style attribute.
     */

    // Properties that carry something the document said. Anything outside this list is
    // either editor bookkeeping or a value the browser already applies by itself.
    var TEXT_PROPERTIES = [
        "font-family", "font-size", "font-weight", "font-style", "font-variant",
        "color", "background-color",
        "text-align", "text-decoration", "text-indent",
        "text-transform", "vertical-align", "line-height", "direction", "list-style-type",
        "margin-top", "margin-right", "margin-bottom", "margin-left",
        "padding-top", "padding-right", "padding-bottom", "padding-left"
    ];

    // An image's style is the layout applyDrawingLayouts just wrote, so it is all load-bearing.
    var IMAGE_PROPERTIES = [
        "width", "height", "max-width", "float", "display", "clear",
        "margin-top", "margin-right", "margin-bottom", "margin-left"
    ];

    var TABLE_TAGS = /^(table|thead|tbody|tfoot|tr|td|th)$/;

    function isKeptProperty(tagName, property) {
        if (tagName === "img") return IMAGE_PROPERTIES.indexOf(property) !== -1;
        if (TABLE_TAGS.test(tagName)) {
            // A table's rules and cell padding ARE its formatting, and the browser expanded
            // each of them into a fistful of longhands, so take the families whole.
            // border-image-* is CSS3 and is what Chrome expands `border:none` into
            // alongside the real longhands, so it has to be named out of the family.
            return (property.indexOf("border") === 0 && property.indexOf("border-image") !== 0) ||
                   property.indexOf("padding") === 0 ||
                   property === "width" || property === "height" ||
                   TEXT_PROPERTIES.indexOf(property) !== -1;
        }
        return TEXT_PROPERTIES.indexOf(property) !== -1;
    }

    // A declaration that restates the initial value changes nothing, and the copy pipeline
    // writes a great many of them. `display` is exempt: display:none is the one "no-op"
    // value that is not one, and dropping it would reveal something the document hides.
    var NOOP_VALUE = /^(0|0%|0pt|0px|0in|0cm|0em|none|inherit|initial|unset|normal|auto|transparent|currentcolor)$/i;

    /**
     * ── CSS 2.1 gate ────────────────────────────────────────────────────────────────
     *
     * Everything this plugin emits has to be readable by a CSS 2.1 renderer - the mail
     * clients, PDF engines and CMS sanitisers that receive exported content are years
     * behind a browser, and a declaration they cannot parse is not degraded, it is dropped
     * along with the rest of the style attribute in the stricter ones.
     *
     * Two halves. The property lists above are already CSS 2.1 only, so the properties are
     * gated by construction; this is the VALUE half, and it matters because the values
     * above are not ours - they come back out of the browser's own CSSOM, which happily
     * re-serialises what the document said into syntax CSS 2.1 never had:
     *
     *   color:#00000080          -> rgba(0, 0, 0, 0.5)           CSS3 colour function
     *   text-decoration:underline-> underline solid rgb(0, 0, 0)  CSS3 shorthand grammar
     *
     * Declarations this plugin writes itself (the page box, the element defaults, the
     * float restored on a wrapped image) are CSS 2.1 by construction and documented as
     * such where they are built.
     */

    // Anything a CSS 2.1 parser has no grammar for. rgba() is handled before this, by
    // flattening; the rest has no CSS 2.1 spelling at all, so the declaration goes.
    var CSS3_VALUE = /(^|[^\w-])(hsla?|calc|var|clamp|env|min|max|oklch|oklab|lab|lch|color-mix|color|image-set|linear-gradient|radial-gradient)\s*\(|\d(rem|vw|vh|vmin|vmax|ch|q)\b|^--|^-(webkit|moz|ms|o)-/i;

    // CSS 2.1 text-decoration: none | [ underline || overline || line-through || blink ].
    var CSS2_DECORATIONS = /^(underline|overline|line-through|blink)$/i;

    // CSS 2.1 display. flex, grid, contents and the rest arrived later.
    var CSS2_DISPLAY = /^(inline|block|list-item|inline-block|table|inline-table|table-row-group|table-header-group|table-footer-group|table-row|table-column-group|table-column|table-cell|table-caption|none)$/i;

    // rgba(r, g, b, a) -> rgb(r, g, b) while it is opaque. A translucent colour has no
    // CSS 2.1 spelling, and forcing it opaque would render something the document hides,
    // so that one is dropped instead and the element keeps its inherited colour.
    function flattenAlpha(value) {
        return value.replace(/rgba\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/gi,
            function (match, red, green, blue, alpha) {
                return parseFloat(alpha) >= 1 ? "rgb(" + red + ", " + green + ", " + blue + ")" : "";
            });
    }

    /**
     * The value as CSS 2.1 would spell it, or "" if it has no CSS 2.1 spelling at all -
     * in which case the caller drops the declaration rather than emit something a strict
     * parser will choke on.
     */
    function css2Value(property, value) {
        var flattened = flattenAlpha(value).trim();
        if (!flattened) return "";

        if (property === "text-decoration") {
            // Chrome serialises the shorthand with the CSS3 style and colour components.
            return flattened.split(/\s+/).filter(function (part) {
                return CSS2_DECORATIONS.test(part);
            }).join(" ");
        }
        if (property === "display") {
            return CSS2_DISPLAY.test(flattened) ? flattened : "";
        }
        return CSS3_VALUE.test(flattened) ? "" : flattened;
    }

    // Style the tag itself already means, so keeping it is duplication. Keyed by the tag as
    // it arrives, before the rename below.
    var IMPLIED_STYLE = {
        b:      ["font-weight"],
        strong: ["font-weight"],
        i:      ["font-style"],
        em:     ["font-style"],
        u:      ["text-decoration"],
        s:      ["text-decoration"],
        strike: ["text-decoration"]
    };

    // Presentational tags the copy pipeline still emits, and their semantic equivalents.
    var RENAMED_TAGS = { b: "strong", i: "em", strike: "s", font: "span" };

    var KEPT_ATTRIBUTE = /^(style|href|src|alt|title|colspan|rowspan|width|height|id|name|target|dir|start|type|lang)$/;

    function pruneAttributes(element) {
        // Live NamedNodeMap - copy the names first, or removing one reindexes the walk.
        var names = Array.prototype.map.call(element.attributes, function (attribute) {
            return attribute.name;
        });
        names.forEach(function (name) {
            if (!KEPT_ATTRIBUTE.test(name.toLowerCase())) element.removeAttribute(name);
        });
    }

    var BOX_SIDES    = ["top", "right", "bottom", "left"];
    var BORDER_PARTS = ["width", "style", "color"];

    // CSS 2.1's own shorthand forms: one value when every side agrees, two when the pairs do.
    function boxShorthand(values) {
        if (values[0] === values[1] && values[1] === values[2] && values[2] === values[3]) {
            return values[0];
        }
        if (values[0] === values[2] && values[1] === values[3]) {
            return values[0] + " " + values[1];
        }
        return values.join(" ");
    }

    /**
     * The CSSOM only ever hands back longhands, so a bordered table cell leaves pruneStyle
     * as twelve declarations saying one thing - `border: 1pt solid #333` expanded to a
     * width, a style and a colour for each of four sides. CSS 2.1 has the shorthands, so
     * fold each family back up when all four sides are present and agree, and leave it
     * expanded when they do not (which is the only case where the longhands say more).
     *
     * A family with a side missing is left alone too: the zeroed sides were dropped as
     * no-ops on the way in, and a shorthand built from what is left would silently reset
     * the others. `margin-left:9.07pt` alone must stay margin-left.
     */
    function collapseShorthands(declarations) {
        var valueOf = declarations.reduce(function (acc, declaration) {
            acc[declaration.property] = declaration.value;
            return acc;
        }, {});

        // longhand -> the shorthand that replaces it, or null for "already covered".
        var replacement = {};
        var fold = function (longhands, property, value) {
            longhands.forEach(function (longhand, index) {
                replacement[longhand] = index === 0 ? { property: property, value: value } : null;
            });
        };

        ["margin", "padding"].forEach(function (name) {
            var longhands = BOX_SIDES.map(function (side) { return name + "-" + side; });
            if (longhands.some(function (longhand) { return valueOf[longhand] === undefined; })) return;
            fold(longhands, name, boxShorthand(longhands.map(function (longhand) {
                return valueOf[longhand];
            })));
        });

        var borderLonghands = [];
        var borderValues    = [];
        var uniform = BORDER_PARTS.every(function (part) {
            var longhands = BOX_SIDES.map(function (side) { return "border-" + side + "-" + part; });
            var first = valueOf[longhands[0]];
            if (first === undefined) return false;
            if (!longhands.every(function (longhand) { return valueOf[longhand] === first; })) return false;
            borderLonghands = borderLonghands.concat(longhands);
            borderValues.push(first);
            return true;
        });
        if (uniform) fold(borderLonghands, "border", borderValues.join(" "));

        return declarations.reduce(function (acc, declaration) {
            if (!(declaration.property in replacement)) return acc.concat(declaration);
            var shorthand = replacement[declaration.property];
            return shorthand ? acc.concat(shorthand) : acc;
        }, []);
    }

    function pruneStyle(element, tagName) {
        var style   = element.style;
        var implied = IMPLIED_STYLE[tagName] || [];
        var declarations = [];

        for (var i = 0; i < style.length; i++) {
            var property = style.item(i);
            if (!isKeptProperty(tagName, property)) continue;
            if (implied.indexOf(property) !== -1) continue;

            var value = css2Value(property, style.getPropertyValue(property).trim());
            if (!value) continue;
            if (property !== "display" && NOOP_VALUE.test(value)) continue;

            declarations.push({ property: property, value: value });
        }

        var folded = collapseShorthands(declarations);
        if (!folded.length) {
            element.removeAttribute("style");
            return;
        }
        element.setAttribute("style", folded.map(function (declaration) {
            return declaration.property + ": " + declaration.value;
        }).join("; ") + ";");
    }

    function renameTags(parsed) {
        var targets = Array.prototype.slice.call(parsed.body.querySelectorAll("b, i, strike, font"));
        targets.forEach(function (element) {
            var replacement = parsed.createElement(RENAMED_TAGS[element.tagName.toLowerCase()]);
            Array.prototype.forEach.call(element.attributes, function (attribute) {
                replacement.setAttribute(attribute.name, attribute.value);
            });
            while (element.firstChild) replacement.appendChild(element.firstChild);
            element.parentNode.replaceChild(replacement, element);
        });
    }

    /**
     * An inline wrapper with nothing inside it renders nothing, and stripping styles leaves
     * a lot of them behind - an empty paragraph arrives as <p><span style="..."></span></p>.
     * Removing one can empty its parent, so repeat until the document stops changing.
     */
    function dropEmptyInlines(parsed) {
        var changed = true;
        while (changed) {
            changed = false;
            var candidates = parsed.body.querySelectorAll("span, strong, em, u, s");
            Array.prototype.forEach.call(candidates, function (element) {
                if (element.childNodes.length) return;
                element.parentNode.removeChild(element);
                changed = true;
            });
        }
    }

    // A <span> that ended up with no attributes is pure noise; its children belong to its
    // parent. querySelectorAll is in document order, so an outer span is unwrapped before
    // the inner ones it holds, and the children it hands up are visited on their own turn.
    function unwrapBareSpans(parsed) {
        var candidates = Array.prototype.slice.call(parsed.body.querySelectorAll("span"));
        candidates.forEach(function (element) {
            if (element.attributes.length) return;
            var parent = element.parentNode;
            while (element.firstChild) parent.insertBefore(element.firstChild, element);
            parent.removeChild(element);
        });
    }

    function dropNodes(parsed, selector) {
        var targets = parsed.body.querySelectorAll(selector);
        Array.prototype.forEach.call(targets, function (element) {
            element.parentNode.removeChild(element);
        });
    }

    function dropComments(parsed) {
        var walker  = parsed.createTreeWalker(parsed.body, window.NodeFilter.SHOW_COMMENT, null, false);
        var comments = [];
        while (walker.nextNode()) comments.push(walker.currentNode);
        comments.forEach(function (comment) {
            comment.parentNode.removeChild(comment);
        });
    }

    function cleanFragment(html) {
        var parsed;
        try {
            parsed = new window.DOMParser().parseFromString(html, "text/html");
        } catch (e) {
            return html;
        }
        if (!parsed || !parsed.body) return html;

        try {
            dropNodes(parsed, "script, style, meta, link, base, title");
            dropComments(parsed);

            Array.prototype.slice.call(parsed.body.querySelectorAll("*")).forEach(function (element) {
                var tagName = element.tagName.toLowerCase();
                pruneAttributes(element);
                pruneStyle(element, tagName);
            });

            renameTags(parsed);
            dropEmptyInlines(parsed);
            unwrapBareSpans(parsed);

            return parsed.body.innerHTML;
        } catch (e) {
            // Whatever went wrong, the untouched fragment is still a correct answer.
            return html;
        }
    }

    /**
     * ── escaping ────────────────────────────────────────────────────────────────────
     *
     * The content leaves here as a plain string, which is what a host wants when it is
     * about to render it. A host that is about to *carry* it wants it escaped, and the two
     * escapings are not interchangeable:
     *
     *   json      JSON.stringify's own output, surrounding quotes included, so the content
     *             IS the JSON string literal - " and \ backslash-escaped, newlines as \n.
     *             Paste it into a payload or a text column as it stands. A host that will
     *             JSON-encode the message itself wants "none", or it escapes it twice.
     *   entities  the markup made inert: & < > " ' as entities, so it renders as visible
     *             source inside a <pre>, a <textarea> or an HTML attribute.
     */
    var ENTITY = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

    function escapeEntities(text) {
        return text.replace(/[&<>"']/g, function (character) {
            return ENTITY[character];
        });
    }

    function applyEscape(content, mode) {
        if (mode === "json")     return JSON.stringify(content);
        if (mode === "entities") return escapeEntities(content);
        return content;
    }

    function escapeResult(result, mode) {
        return Object.assign({}, result, {
            escape:  mode,
            content: applyEscape(result.content, mode)
        });
    }

    /**
     * The HTML pipeline, in the order the stages have to run:
     *
     *   GetFileHTML -> layout repair -> markup (clean | full) -> page box -> escaping
     *
     * Cleaning comes before the page box because the box is the host's frame, not the
     * document's markup; escaping comes last because it turns markup into a payload and
     * nothing can be done to it afterwards.
     */
    function buildHtml(fragment, options, source) {
        var markup = (options.markup === "clean") ? cleanFragment(fragment) : fragment;

        if (!options.frame) {
            return Promise.resolve({
                format:  "html",
                content: markup,
                meta:    { source: source, markup: options.markup }
            });
        }

        return readDocumentMeta().then(function (meta) {
            meta.source = source;
            meta.markup = options.markup;
            return {
                format: "html",
                // "full" is the fidelity path: the page box only holds its shape if every
                // element inside it has had the host's own defaults zeroed first.
                content: (options.markup === "clean")
                    ? wrapInPage(markup, meta)
                    : selfContainedHtml(markup, meta),
                meta: meta
            };
        });
    }

    function extract(request) {
        var options = normalizeSettings(Object.assign({}, settings, request.options || {}));
        if (request.format !== undefined) options.format = normalizeFormat(request.format);
        if (request.markup !== undefined) options.markup = normalizeMarkup(request.markup);
        if (request.escape !== undefined) options.escape = normalizeEscape(request.escape);

        var run = (options.format === "markdown") ? extractMarkdown : extractHtml;

        return run(options).then(function (result) {
            if (!result.content) {
                throw new Error(
                    "the " + (window.Asc.plugin.info.editorType || "current") + " editor returned no " +
                    options.format + " content - only the document editor can export it"
                );
            }
            if (options.format === "markdown") {
                return { format: "markdown", content: result.content, meta: { source: result.source } };
            }
            return buildHtml(result.content, options, result.source);
        }).then(function (result) {
            return escapeResult(result, options.escape);
        });
    }

    // ── host channel ────────────────────────────────────────────────────────────────

    function post(target, payload) {
        if (!target) return;
        try {
            target.postMessage(Object.assign({ channel: CHANNEL }, payload), "*");
        } catch (e) { /* the host went away */ }
    }

    // The host may mount its listener after we start, and we have no way to address it
    // until it answers, so keep announcing until it acks (or we give up).
    function announceReady() {
        var payload = {
            type:     "ready",
            guid:     window.Asc.plugin.info ? window.Asc.plugin.info.guid : undefined,
            editor:   window.Asc.plugin.info ? window.Asc.plugin.info.editorType : undefined,
            settings: settings
        };
        post(window.top, payload);
        if (window.parent && window.parent.parent && window.parent.parent !== window.top) {
            post(window.parent.parent, payload);
        }
    }

    function startReadyBeacon() {
        announceReady();
        stopReadyBeacon();
        readyTimer = window.setInterval(function () {
            readyAttempts += 1;
            if (hostWindow || readyAttempts > READY_BEACON_LIMIT) {
                stopReadyBeacon();
                return;
            }
            announceReady();
        }, READY_BEACON_MS);
    }

    function stopReadyBeacon() {
        if (readyTimer) {
            window.clearInterval(readyTimer);
            readyTimer = null;
        }
    }

    function closeSettingsWindow() {
        if (!settingsWindow) return;
        var open = settingsWindow;
        settingsWindow = null;
        try {
            open.close();
        } catch (e) { /* already gone */ }
    }

    function openSettingsWindow() {
        // The plugin has no panel of its own (isVisual:false), so its settings live in an
        // Asc.PluginWindow the host asks us to open.
        if (settingsWindow) {
            settingsWindow.activate();
            return;
        }
        settingsWindow = new window.Asc.PluginWindow();
        settingsWindow.attachEvent("onSettingsSaved", function (next) {
            var saved = writeSettings(next);
            post(hostWindow, { type: "settings", settings: saved });
            closeSettingsWindow();
        });
        settingsWindow.attachEvent("onSettingsReady", function () {
            settingsWindow.command("loadSettings", settings);
        });
        settingsWindow.show({
            url:       "settings.html",
            description: "Sarv Content Export",
            isVisual:  true,
            isModal:   true,
            isViewer:  true,
            EditorsSupport: ["word"],
            // Roomy enough that the Integration tab's snippets do not wrap.
            size:      [560, 560],
            // Drawn by the editor, so the window carries the same footer as every other
            // plugin window. Save comes back through Asc.plugin.button as id 0.
            buttons:   [
                { text: "Save",   primary: true  },
                { text: "Cancel", primary: false }
            ]
        });
    }

    /**
     * A button in the editor's own Plugins tab, so the settings are reachable from inside
     * the editor and not only from the host page.
     *
     * An isVisual:false plugin has no panel and therefore no entry in the plugin list, so
     * AddToolbarMenuItem is the only way in. Tab id "plugins" lands the button in the
     * existing Plugins tab rather than creating one of its own (Mixtbar.addCustomControls
     * falls back to getTab('plugins')). The icon path is a template - %scale%(default)
     * expands to the @1.25x/@1.5x/@1.75x/@2x set we already ship, and because it sits
     * right after a "/" the expansion is named "icon", i.e. resources/light/icon@1.5x.png.
     * It is resolved against the plugin's own baseUrl by the editor.
     */
    var TOOLBAR_ITEM_ID = "sarv-content-export-settings";

    function addToolbarButton() {
        var guid = window.Asc.plugin.guid || (window.Asc.plugin.info && window.Asc.plugin.info.guid);
        if (!guid || typeof window.Asc.plugin.attachToolbarMenuClickEvent !== "function") return;

        window.Asc.plugin.attachToolbarMenuClickEvent(TOOLBAR_ITEM_ID, function () {
            try {
                openSettingsWindow();
            } catch (e) { /* already open */ }
        });

        window.Asc.plugin.executeMethod("AddToolbarMenuItem", [{
            guid: guid,
            tabs: [{
                id:   "plugins",
                text: "Plugins",
                items: [{
                    id:      TOOLBAR_ITEM_ID,
                    type:    "big-button",
                    icons:   "resources/%theme-type%(light|dark)/icon%scale%(default).%extension%(png)",
                    text:    "Content Export",
                    hint:    "Choose whether this document is handed to the page as HTML or Markdown",
                    lockInViewMode: false
                }]
            }]
        }]);
    }

    function handleHostMessage(event) {
        var data = event.data;
        if (!data || data.channel !== CHANNEL) return;

        // Anything that reaches us is from a frame above; latch it as the host.
        if (event.source) hostWindow = event.source;

        switch (data.type) {
            case "ack":
                stopReadyBeacon();
                post(hostWindow, { type: "settings", settings: settings });
                break;

            case "getSettings":
                post(hostWindow, { type: "settings", requestId: data.requestId, settings: settings });
                break;

            case "setSettings":
                post(hostWindow, { type: "settings", requestId: data.requestId, settings: writeSettings(Object.assign({}, settings, data.settings)) });
                break;

            case "openSettings":
                try {
                    openSettingsWindow();
                } catch (err) {
                    post(hostWindow, { type: "error", requestId: data.requestId, ok: false, message: String(err && err.message || err) });
                }
                break;

            case "extract":
                extract(data).then(function (result) {
                    post(hostWindow, {
                        type:      "result",
                        requestId: data.requestId,
                        ok:        true,
                        format:    result.format,
                        // Which escaping content is in, so a host that did not ask for one
                        // still knows whether it is holding markup or a payload.
                        escape:    result.escape,
                        content:   result.content,
                        meta:      result.meta
                    });
                }).catch(function (err) {
                    post(hostWindow, {
                        type:      "error",
                        requestId: data.requestId,
                        ok:        false,
                        message:   String(err && err.message || err)
                    });
                });
                break;

            default:
                break;
        }
    }

    // ── plugin lifecycle ────────────────────────────────────────────────────────────

    window.Asc.plugin.init = function () {
        settings = readSettings();
        window.addEventListener("message", handleHostMessage, false);
        startReadyBeacon();
        try {
            addToolbarButton();
        } catch (e) { /* older editor without AddToolbarMenuItem - host settings still work */ }
    };


    /**
     * Every button press inside a plugin modal lands here - including the X, which the
     * editor delivers as id -1 plus the id of the window it came from (Plugins.js
     * toolcallback -> asc_pluginButtonClick(-1, guid, frameId)). The editor does NOT
     * close the window itself; the plugin has to.
     *
     * Closing only that window matters: the default handler closes the whole plugin, and
     * a plugin close runs LayoutManager.clearCustomControls(guid), which strips our
     * Plugins-tab button - and would also tear down the host postMessage channel this
     * background worker exists for. So there is no case in which this plugin closes
     * itself; a press with no window id is simply ignored.
     */
    window.Asc.plugin.button = function (buttonId, windowId) {
        if (windowId === undefined || windowId === null) return;
        // 0 = Save: the values live in the window, so ask for them - it answers with
        // onSettingsSaved, which persists them and closes. Anything else (Cancel, X)
        // just dismisses.
        if (buttonId === 0 && settingsWindow) {
            settingsWindow.command("collectSettings");
            return;
        }
        closeSettingsWindow();
    };

    window.Asc.plugin.onExternalPluginMessage = function (data) {
        // Only reachable on builds with the advancedApi license flag; harmless otherwise.
        handleHostMessage({ data: Object.assign({ channel: CHANNEL }, data), source: hostWindow });
    };

})(window, undefined);
