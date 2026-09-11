/*
 * Content Filter Worker — resident content policy enforcement
 *
 * A system plugin: the editor starts it with the document and never shows it. It keeps the
 * organization's rule list up to date, scans the whole document on a timer and, whenever a
 * disallowed word is present:
 *
 *   1. highlights every occurrence, the way the search panel highlights its matches - no edit
 *      is made, nothing reaches the file and co-authors see nothing;
 *   2. holds the save and the download shut, with a message naming the words;
 *   3. broadcasts what it found, so the Content Filter panel can list it without rescanning.
 *
 * The highlight and the block are editor methods reserved for system plugins - see
 * Api#pluginMethod_HighlightTerms and Api#pluginMethod_SetContentPolicyBlock in sdkjs.
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
    let isScanning     = false;
    let scanTimer      = null;
    let scanIntervalMs = core.DEFAULT_SCAN_MS;
    let channel        = null;

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

    /** The message the editor shows when it refuses a save. */
    const blockMessage = (words) => {
        const listed = words.slice(0, 8).join(", ");
        const rest   = words.length > 8 ? (" +" + (words.length - 8) + " more") : "";
        return window.Asc.plugin.tr("This document cannot be saved while it contains content your organization does not allow")
            + ": " + listed + rest + ". "
            + window.Asc.plugin.tr("The words are highlighted in the document. Remove them and save again.");
    };

    const sameWords = (left, right) =>
        left.length === right.length && left.every((word, index) => word === right[index]);

    /**
     * Brings the editor in line with what the last scan found. Called on every scan, so it
     * does nothing at all while the answer has not changed - a repeated highlight would throw
     * away the reader's scroll position and a repeated block would be pointless work.
     * @param {Array.<string>} words
     * @param {boolean} [isHighlighted] - true when the scan itself searched through the editor
     * and the matches are already painted, so only the block is left to set.
     */
    const applyToEditor = (words, isHighlighted) => {
        if (sameWords(words, blockedWords)) return;

        blockedWords = words;

        if (!words.length) {
            editorMethod("SetContentPolicyBlock", [""]);
            if (!isHighlighted) editorMethod("ClearHighlightTerms");
            return;
        }

        if (!isHighlighted) editorMethod("HighlightTerms", [words, { matchCase: false, wholeWords: false }]);
        editorMethod("SetContentPolicyBlock", [blockMessage(words)]);
    };

    const publish = () => {
        if (!channel) return;
        channel.publish({
            channel:    core.CHANNEL_NAME,
            type:       "scan",
            editorType: editorType,
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
                applyToEditor(core.matchedWords(violations));
            } else {
                violations = await core.detectWithEditorSearch(rules, SCAN_TIMEOUT_MS);
                applyToEditor(core.matchedWords(violations), true);
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
            await scanNow();
        } catch (error) {
            // The cached rules stay in force: a policy that cannot be refreshed is still a
            // policy, and going quiet on a network error would be the wrong way to fail.
        }
    };

    /** The panel asks for things over the channel; nothing else is listened to. */
    const onChannelMessage = (message) => {
        if (!message || message.channel !== core.CHANNEL_NAME) return;

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

    window.Asc.plugin.init = function () {
        editorType = (window.Asc.plugin.info && window.Asc.plugin.info.editorType) || "word";

        channel = core.openChannel(onChannelMessage);

        // Start from the cache so the first scan does not wait on the network, then refresh.
        rules = core.loadCachedRules().rules;
        runScanCycle();
        refreshRules();
    };

})(window);
