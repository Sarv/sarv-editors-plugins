/*
 * Content Filter Worker — resident content policy enforcement
 *
 * A system plugin: the editor starts it with the document and never shows it. It keeps the
 * organization's rule list up to date, scans the whole document on a timer and, whenever a
 * disallowed word is present:
 *
 *   1. marks every occurrence - no edit is made, nothing reaches the file and co-authors see
 *      nothing;
 *   2. holds the save and the download shut, with a message naming the words;
 *   3. broadcasts what it found, so the Content Filter panel can list it without rescanning.
 *
 * How the first two are done depends on the editor. Where the editor can mark the document
 * itself (SetContentPolicyTerms - the document editor), the rules are simply handed over: the
 * engine then marks every occurrence with an orange double wave that survives editing, explains
 * the mark on hover, re-reads only the paragraph that changed, and moves the block itself. The
 * scan below then only reads the document to list the violations for the panel - it neither
 * marks nor blocks, which is why typing no longer drops the marking on the rest of the document
 * and why the marking of a newly typed word no longer waits for the next scan.
 *
 * Where the editor cannot (spreadsheet, presentation, pdf), the older path stands: highlight the
 * matches the way the search panel does, repaint that highlight whenever an edit has made the
 * editor drop it, and set the block from here.
 *
 * All of these are editor methods reserved for system plugins - see
 * Api#pluginMethod_SetContentPolicyTerms, Api#pluginMethod_HighlightTerms and
 * Api#pluginMethod_SetContentPolicyBlock in sdkjs.
 *
 * This is the client half of the policy and exists to tell the user what is wrong while they
 * can still fix it. It is not the enforcement boundary: co-authored changes reach other clients
 * before any save, so the drive's own save callback is what finally refuses a version.
 */
(function (window) {
    "use strict";

    const core = window.SarvContentPolicy;

    const MIN_SCAN_MS = 1500;   // a floor on the timer, whatever the configured interval says
    const SCAN_TIMEOUT_MS = 10000;

    let rules          = core.emptyRules();
    let editorType     = "word";
    let violations     = [];
    let blockedWords   = [];    // what the editor was last told to block on
    let blockedMarked  = false; // whether that block's message promised a highlight
    let isPainted      = false; // whether the last highlight actually marked anything
    let isEngineMarks  = false; // whether the editor marks and blocks on its own (see the header)
    let isScanning     = false;
    let scanTimer      = null;
    let scanIntervalMs = core.DEFAULT_SCAN_MS;
    let channel        = null;
    let documentKey    = "";    // which document this worker's broadcasts are about

    const editorMethod = (name, args) => {
        try {
            window.Asc.plugin.executeMethod(name, args || [], () => {});
            return true;
        } catch (error) {
            // An editor without these methods (an unpatched build) simply cannot enforce the
            // policy on the client; the scan and the broadcast still work.
            return false;
        }
    };

    /** The same call, waited on, for the methods whose answer decides what to do next. */
    const askEditor = (name, args) => new Promise((resolve) => {
        try {
            window.Asc.plugin.executeMethod(name, args || [], (answer) => resolve(answer));
        } catch (error) {
            resolve(undefined);
        }
    });

    /**
     * Marks every occurrence of the given words and remembers whether anything was marked.
     * A word the scan read out of the document's text but the editor's own search cannot find -
     * a phrase that spans a paragraph break, say - marks nothing, and knowing that is what stops
     * the repaint below from trying again on every scan.
     */
    const paintHighlight = async (words) => {
        const result = await askEditor("HighlightTerms", [words, { matchCase: false, wholeWords: false }]);
        isPainted = !!(result && result.count > 0);
    };

    /**
     * Paints the highlight again when the editor has dropped it. Recalculating the document
     * throws the search results away, and the document is recalculated on every edit - so the
     * words the user was shown stop being marked the moment they type anything else, and the
     * scan that follows would otherwise leave the document unmarked because it found the same
     * words as the scan before it.
     */
    const restoreHighlight = async (words) => {
        if (!isPainted) return;   // never marked anything; nothing to restore

        const count = await askEditor("GetHighlightTermsCount");
        if (count === undefined) return;   // an editor that cannot answer cannot be repainted
        if (count > 0) return;             // still marked

        await paintHighlight(words);
    };

    /**
     * Hands the rule list to the editor, which then does the marking and the blocking itself.
     * Called whenever the rules change and nowhere else: the engine keeps the marking in step
     * with the document on its own, so there is nothing to repeat on a timer.
     *
     * The wording goes with the rules - the editor draws the tooltip and composes the refusal,
     * but the words in them stay this plugin's to translate.
     */
    const pushRulesToEngine = async () => {
        const terms = (rules.disallowed || []).map((rule) => ({
            text:     rule.text,
            category: rule.category
        }));
        const allowed = (rules.allowed || []).map((rule) => rule.text);

        const result = await askEditor("SetContentPolicyTerms", [terms, {
            allowed:  allowed,
            messages: {
                tooltipTitle: window.Asc.plugin.tr("Not allowed by your organization's content policy"),
                tooltipText:  window.Asc.plugin.tr("\"{word}\" cannot be saved in this document. Remove it, then save."),
                block:        window.Asc.plugin.tr("This document cannot be saved while it contains content your organization does not allow")
                                  + ": {words}. "
                                  + window.Asc.plugin.tr("The words are marked in the document. Remove them and save again.")
            }
        }]);

        // null comes back from an editor that cannot mark the document itself, and from one that
        // is not ready yet; either way the older highlight path has to carry the policy.
        isEngineMarks = (result !== null && result !== undefined);
        return isEngineMarks;
    };

    /**
     * The message the editor shows when it refuses a save. It only promises a highlight when
     * there is one: a word the scan read but the editor's own search cannot mark - text inside
     * a spreadsheet's text box, whose search engine only ever looks at cells - is still named
     * here, and telling the user to look for a marking that is not there would send them
     * hunting for it.
     */
    const blockMessage = (words, isMarked) => {
        const listed = words.slice(0, 8).join(", ");
        const rest   = words.length > 8 ? (" +" + (words.length - 8) + " more") : "";
        return window.Asc.plugin.tr("This document cannot be saved while it contains content your organization does not allow")
            + ": " + listed + rest + ". "
            + (isMarked
                ? window.Asc.plugin.tr("The words are highlighted in the document. Remove them and save again.")
                : window.Asc.plugin.tr("Remove them and save again."));
    };

    const sameWords = (left, right) =>
        left.length === right.length && left.every((word, index) => word === right[index]);

    /**
     * Brings the editor in line with what the last scan found. Called on every scan, so the
     * block is only ever re-stated when the words it names have changed - but the highlight is
     * checked every time, because the editor drops it whenever the document is recalculated and
     * the words would otherwise stay unmarked for as long as the user keeps typing.
     * @param {Array.<string>} words
     * @param {boolean} [isHighlighted] - true when the scan itself searched through the editor
     * and the matches are already painted, so only the block is left to set.
     */
    const applyToEditor = async (words, isHighlighted) => {
        const isChanged = !sameWords(words, blockedWords);
        blockedWords = words;

        // The editor is marking and blocking off its own copy of the rules; the scan that got
        // here was only reading the document to list the violations for the panel.
        if (isEngineMarks) return;

        if (!words.length) {
            if (!isChanged) return;
            editorMethod("SetContentPolicyBlock", [""]);
            if (!isHighlighted) editorMethod("ClearHighlightTerms");
            isPainted = false;
            blockedMarked = false;
            return;
        }

        // Marked first, then blocked: the block is what the user is told about, and by the time
        // they are told the words it names are already pointed out in the document.
        if (isHighlighted) {
            // The scan searched through the editor itself, so the matches are already marked.
            isPainted = true;
        } else if (isChanged) {
            await paintHighlight(words);
        } else {
            await restoreHighlight(words);
        }

        // Re-stated when the marking changed as well as when the words did: the message says
        // whether the words are marked, so a repaint that finally took hold has to correct it.
        if (isChanged || isPainted !== blockedMarked) {
            blockedMarked = isPainted;
            editorMethod("SetContentPolicyBlock", [blockMessage(words, isPainted)]);
        }
    };

    const publish = () => {
        if (!channel) return;
        channel.publish({
            channel:     core.CHANNEL_NAME,
            type:        "scan",
            // Which document this is about. A BroadcastChannel reaches every tab of the same
            // origin, so a panel has to be able to tell this worker's document from the one open
            // in the tab next to it - see core.documentKey.
            documentKey: documentKey,
            editorType:  editorType,
            violations: violations,
            words:      blockedWords,
            blocked:    blockedWords.length > 0,
            at:         Date.now()
        });
    };

    const scanNow = async () => {
        if (isScanning) return;
        isScanning = true;

        try {
            const text = await core.collectDocumentText(editorType, SCAN_TIMEOUT_MS);

            // No text at all means the editor does not hand its content to a plugin - the pdf
            // editor, whose pages expose annotations and widgets but never their text. There the
            // engine's own search is the reader, and it highlights as it counts.
            if (text) {
                violations = core.scanText(text, rules);
                await applyToEditor(core.matchedWords(violations));
            } else {
                violations = await core.detectWithEditorSearch(rules, SCAN_TIMEOUT_MS);
                await applyToEditor(core.matchedWords(violations), true);
            }

            publish();
        } catch (error) {
            // A scan that could not read the document says nothing about the document, so the
            // previous verdict stands rather than the block being lifted on an error.
        } finally {
            isScanning = false;
        }
    };

    /**
     * One scan at a time, each one arming the next. A self-rescheduling timeout rather than an
     * interval so the delay is re-read from the config on every tick - changing the interval in
     * the panel's Settings then takes effect without a reload - and so a slow scan on a large
     * document can never have a second scan queued up behind it.
     */
    const scheduleNextScan = () => {
        const configured = core.getConfig().scanIntervalMs;
        scanIntervalMs = (configured === undefined) ? core.DEFAULT_SCAN_MS : configured;

        if (scanTimer) {
            window.clearTimeout(scanTimer);
            scanTimer = null;
        }
        if (scanIntervalMs <= 0) return;   // 0 turns the timer off; scans then only happen on request

        scanTimer = window.setTimeout(runScanCycle, Math.max(scanIntervalMs, MIN_SCAN_MS));
    };

    const runScanCycle = async () => {
        await scanNow();
        scheduleNextScan();
    };

    const refreshRules = async () => {
        try {
            const result = await core.syncRules(rules);
            rules = result.rules;

            // The editor's copy first: it is what marks the document and refuses the save, and
            // it should not be a scan behind the rules it is enforcing.
            await pushRulesToEngine();
            await scanNow();
        } catch (error) {
            // The cached rules stay in force: a policy that cannot be refreshed is still a
            // policy, and going quiet on a network error would be the wrong way to fail.
        }
    };

    /** The panel asks for things over the channel; nothing else is listened to. */
    const onChannelMessage = (message) => {
        if (!message || message.channel !== core.CHANNEL_NAME) return;

        // A request from the panel of another document is that worker's to answer, not this one's.
        if (!core.isSameDocument(documentKey, message, editorType)) return;

        switch (message.type) {
            case "requestScan":
                scanNow();
                break;
            case "requestState":
                publish();
                break;
            case "rulesChanged":
                refreshRules();
                break;
            default:
                break;
        }
    };

    /**
     * The integrator changed `editorConfig.plugins.options` mid-session - a rotated token, a
     * different endpoint. The rules now in force may have come from the old one, so they are
     * fetched again rather than waiting for the cache to expire.
     */
    window.Asc.plugin.onUpdateOptions = function () {
        refreshRules();
    };

    window.Asc.plugin.init = async function () {
        editorType = (window.Asc.plugin.info && window.Asc.plugin.info.editorType) || "word";

        channel = core.openChannel(onChannelMessage);

        // Before the first scan, so nothing is ever broadcast unstamped.
        documentKey = await core.documentKey();

        // Start from the cache so neither the marking nor the first scan waits on the network,
        // then refresh from the endpoint.
        rules = core.loadCachedRules().rules;

        // Asked rather than assumed from the editor type: an older editor build has neither
        // method, and answering "word" there would leave the document unmarked.
        isEngineMarks = !!(await askEditor("IsContentPolicyMarksSupported"));
        if (isEngineMarks) await pushRulesToEngine();

        runScanCycle();
        refreshRules();
    };

})(window);
