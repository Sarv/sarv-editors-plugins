/**
 * Settings window for Sarv Content Export.
 *
 * The plugin itself is invisible (isVisual:false), so it has no panel to host settings.
 * The host page asks the background worker to open this as an Asc.PluginWindow; the
 * worker owns the persisted values and this frame only reads and writes them over the
 * window channel:
 *
 *   window -> worker : sendToPlugin("onSettingsReady")           ask for current values
 *                      sendToPlugin("onSettingsSaved", settings) commit
 *   worker -> window : command("loadSettings", settings)         current values
 *                      command("collectSettings")                the footer Save was pressed
 *
 * The footer buttons are drawn by the editor, like every other plugin window, so Save
 * arrives at the worker (button id 0) rather than here - it asks us for the values.
 *
 * The window also carries an Integration tab: a step-by-step guide for whoever embeds the
 * editor. It holds no settings; the only behaviour it needs is tab switching, the snippet
 * copy buttons, and filling the first snippet with this deployment's own config.json URL
 * and guid so it can be pasted as it stands.
 */
(function (window, undefined) {
    "use strict";

    var FIELDS = {
        base64img:      "opt-base64img",
        frame:          "opt-frame",
        htmlHeadings:   "opt-htmlheadings",
        demoteHeadings: "opt-demoteheadings",
        renderHTMLTags: "opt-renderhtmltags"
    };

    function checkbox(key) {
        return document.getElementById(FIELDS[key]);
    }

    // The three-way choices, with the value normalizeSettings falls back to.
    var CHOICES = {
        format: { values: ["html", "markdown"],           fallback: "html"  },
        markup: { values: ["clean", "full"],              fallback: "clean" },
        escape: { values: ["none", "json", "entities"],   fallback: "none"  }
    };

    function applyChoice(name, value) {
        var choice = CHOICES[name];
        var wanted = (choice.values.indexOf(value) === -1) ? choice.fallback : value;
        var radio  = document.querySelector('input[name="' + name + '"][value="' + wanted + '"]');
        if (radio) radio.checked = true;
    }

    function readChoice(name) {
        var selected = document.querySelector('input[name="' + name + '"]:checked');
        return selected ? selected.value : CHOICES[name].fallback;
    }

    function applySettings(settings) {
        Object.keys(CHOICES).forEach(function (name) {
            applyChoice(name, settings && settings[name]);
        });

        Object.keys(FIELDS).forEach(function (key) {
            var input = checkbox(key);
            if (input) input.checked = !!(settings && settings[key]);
        });
    }

    function collectSettings() {
        return Object.keys(FIELDS).reduce(function (acc, key) {
            var input = checkbox(key);
            acc[key] = !!(input && input.checked);
            return acc;
        }, Object.keys(CHOICES).reduce(function (acc, name) {
            acc[name] = readChoice(name);
            return acc;
        }, {}));
    }

    // ---- the integrator's config block --------------------------------------------

    // Last-resort values, for the case where this page is opened outside the editor.
    var GUID = "asc.{7B2C9E14-5D63-4A81-9F0E-2C6A8D3B4F52}";

    // config.json sits beside this file, and this file is served from wherever the plugin
    // is actually deployed - so the deployed URL is simply resolved against our own. That
    // makes the snippet true for dev, staging and production without anyone editing it.
    function pluginConfigUrl() {
        try {
            return new URL("config.json", window.location.href).href;
        } catch (e) {
            return window.location.href.replace(/[^/]*$/, "") + "config.json";
        }
    }

    function pluginGuid() {
        var plugin = window.Asc && window.Asc.plugin;
        return (plugin && plugin.guid) ||
               (plugin && plugin.info && plugin.info.guid) ||
               GUID;
    }

    function fillConfigSnippet() {
        var target = document.getElementById("snippet-config");
        if (!target) return;
        target.textContent = [
            "editorConfig: {",
            "  plugins: {",
            '    pluginsData: ["' + pluginConfigUrl() + '"],',
            '    autostart:   ["' + pluginGuid() + '"]',
            "  }",
            "}"
        ].join("\n");
    }

    // ---- tabs -------------------------------------------------------------------

    function selectTab(tab) {
        var tabs = document.querySelectorAll(".tab");
        for (var i = 0; i < tabs.length; i++) {
            var current = tabs[i] === tab;
            tabs[i].setAttribute("aria-selected", current ? "true" : "false");
            document.getElementById(tabs[i].getAttribute("aria-controls")).hidden = !current;
        }
    }

    function initTabs() {
        var tabs = document.querySelectorAll(".tab");
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].addEventListener("click", function (event) {
                selectTab(event.currentTarget);
            });
        }
    }

    // ---- snippet copy buttons -----------------------------------------------------

    // The editor builds the plugin iframe without allow="clipboard-write", so the async
    // clipboard API is present but permission-denied here; a hidden textarea plus
    // execCommand is not policy-gated and is what actually does the work. If even that is
    // refused, select the snippet so the reader can copy it by hand.
    function copyWithTextarea(text) {
        var area = document.createElement("textarea");
        area.value = text;
        area.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0";
        document.body.appendChild(area);
        area.select();
        var copied = false;
        try {
            copied = document.execCommand("copy");
        } catch (e) { /* refused */ }
        area.parentNode.removeChild(area);
        return copied;
    }

    function selectSnippet(snippet) {
        var range = document.createRange();
        range.selectNodeContents(snippet.querySelector("pre"));
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function copySnippet(snippet) {
        var text = snippet.querySelector("pre").textContent;
        var allowed = !document.featurePolicy ||
                      document.featurePolicy.allowsFeature("clipboard-write");

        if (allowed && window.navigator.clipboard && window.navigator.clipboard.writeText) {
            return window.navigator.clipboard.writeText(text);
        }
        if (copyWithTextarea(text)) return Promise.resolve();

        selectSnippet(snippet);
        return Promise.reject(new Error("select and copy"));
    }

    function flash(button, text) {
        var label = button.textContent;
        button.textContent = text;
        button.disabled = true;
        window.setTimeout(function () {
            button.textContent = label;
            button.disabled = false;
        }, 1200);
    }

    function initSnippetCopy() {
        var snippets = document.querySelectorAll(".snippet");
        for (var i = 0; i < snippets.length; i++) {
            (function (snippet) {
                var button = document.createElement("button");
                button.type = "button";
                button.className = "copy";
                button.textContent = "Copy";
                button.addEventListener("click", function () {
                    copySnippet(snippet).then(function () {
                        flash(button, "Copied");
                    }).catch(function () {
                        flash(button, "Press Ctrl+C");
                    });
                });
                snippet.appendChild(button);
            })(snippets[i]);
        }
    }

    window.Asc.plugin.init = function () {
        fillConfigSnippet();
        initTabs();
        initSnippetCopy();

        window.Asc.plugin.attachEvent("loadSettings", applySettings);
        window.Asc.plugin.attachEvent("collectSettings", function () {
            window.Asc.plugin.sendToPlugin("onSettingsSaved", collectSettings());
        });
        window.Asc.plugin.sendToPlugin("onSettingsReady");
    };

})(window, undefined);
