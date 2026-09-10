/**
 *
 * (c) Copyright Sarv 2021
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

/**
 * Makes the editor UI theme usable from plugin CSS.
 *
 * The editor hands every plugin frame the resolved colours of the current theme in
 * `window.Asc.plugin.theme` (`text-normal`, `background-normal`, `border-divider`, ...,
 * plus `type`: "dark" or "light"). Out of the box only the handful of selectors in
 * plugin_base.js' own theme map get those colours, so any markup a plugin adds itself
 * keeps whatever was hardcoded in its stylesheet - which is how a light-theme panel ends
 * up with light text on a light pill once the editor turns dark.
 *
 * This publishes every token as a CSS custom property on <html>, so a stylesheet can just
 * say `var(--text-normal, <light fallback>)` and follow the editor. It also stamps
 * `data-theme-type` for the rare rule that needs to branch on dark vs light outright.
 *
 * Load it after ../v1/plugins.js and before the plugin's own script:
 *
 *     <script src="../v1/plugins.js"></script>
 *     <script src="../v1/plugin-theme.js"></script>
 *
 * A plugin that needs to do more on a theme change assigns `SarvPluginTheme.onChange`;
 * it must not define `Asc.plugin.onThemeChanged` itself, since that is what drives this.
 */
(function (window, undefined) {
    "use strict";

    const NON_COLOR_KEYS = ["type", "name"];

    const isPublishable = (key, value) =>
        typeof value === "string" && value !== "" && NON_COLOR_KEYS.indexOf(key) === -1;

    /** Pushes the theme's colour tokens onto <html> as --<token> custom properties. */
    const publishTokens = (theme) => {
        const root = document.documentElement;
        if (!root || !theme) return;

        Object.keys(theme).forEach((key) => {
            if (isPublishable(key, theme[key]))
                root.style.setProperty("--" + key, theme[key]);
        });

        const type = theme.type === "dark" ? "dark" : "light";
        root.setAttribute("data-theme-type", type);
        if (theme.name) root.setAttribute("data-theme-name", theme.name);

        // Native checkboxes, radios and scrollbars are drawn by the browser and ignore the
        // tokens; color-scheme is the only way to keep them from staying light on a dark panel.
        root.style.colorScheme = type;
    };

    const applyTheme = (theme) => {
        if (!theme) return;
        publishTokens(theme);
        if (typeof window.SarvPluginTheme.onChange === "function")
            window.SarvPluginTheme.onChange(theme);
    };

    window.SarvPluginTheme = {
        apply: applyTheme,
        onChange: null
    };

    window.Asc = window.Asc || {};
    window.Asc.plugin = window.Asc.plugin || {};

    window.Asc.plugin.onThemeChanged = function (theme) {
        // Keep the base map too: it is what colours <body> and the shared plugins.css controls.
        if (window.Asc.plugin.onThemeChangedBase)
            window.Asc.plugin.onThemeChangedBase(theme);
        applyTheme(theme);
    };

    // The theme can already be on the plugin object by the time this file runs, in which
    // case onThemeChanged is never called for it.
    if (window.Asc.plugin.theme)
        applyTheme(window.Asc.plugin.theme);

})(window, undefined);
