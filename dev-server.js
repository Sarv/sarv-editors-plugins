/**
 * Plugin dev server
 *
 * Serves all plugin files over HTTP so Sarv Office can load them instantly
 * without pushing to GitHub.
 *
 * Usage:
 *   node dev-server.js
 *
 * In Office → Plugin Manager → set plugins index URL to:
 *   http://localhost:30300/plugins-index.json
 *
 * The /plugins-index.json endpoint rewrites all GitHub URLs to localhost,
 * so every plugin in the repo is served locally. Individual plugin config
 * URLs are also rewritten the same way in their config.json responses.
 *
 * Changes to any HTML/JS/CSS are picked up immediately —
 * just close and reopen the plugin panel (no push needed).
 *
 * ── Per-plugin enable/disable ────────────────────────────────────────────
 * Add an "enabled" field to any plugin's own config.json — no other changes
 * needed anywhere:
 *
 *   "enabled": true              → enabled for all editors (default, same as absent)
 *   "enabled": false             → disabled; removed from the plugins index
 *   "enabled": ["word", "cell"]  → enabled only for those editors (overrides EditorsSupport)
 * ─────────────────────────────────────────────────────────────────────────
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT   = 30300;
const ROOT   = __dirname;
const ORIGIN = 'http://localhost:' + PORT;
const GITHUB = 'https://sarv.github.io/sarv-editors-plugins';

const MIME = {
    '.html': 'text/html',
    '.js':   'text/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.txt':  'text/plain',
};

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control':                'no-store',
    };
}

// Rewrite all GitHub CDN refs to localhost inside JSON text
function localizeJson(text) {
    return text.split(GITHUB).join(ORIGIN);
}

// Extract plugin folder name from a config.json URL
//   ".../content-filter/config.json"  →  "content-filter"
function pluginIdFromUrl(urlStr) {
    var m = urlStr.match(/\/([^/]+)\/config\.json/);
    return m ? m[1] : null;
}

// Read and parse a plugin's local config.json synchronously.
// Returns null if the file is missing or unparseable.
function readPluginConfig(pluginId) {
    try {
        var p = path.join(ROOT, pluginId, 'config.json');
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { return null; }
}

// Build the filtered + localized plugins index.
// For each entry in the index, reads the plugin's own config.json and checks
// the top-level "enabled" field:
//   absent / true        → keep
//   false                → remove
//   ["word", "cell", …]  → keep (EditorsSupport will be overridden when serving config.json)
function buildIndex(rawUrls) {
    return rawUrls.filter(function (u) {
        var id  = pluginIdFromUrl(u);
        if (!id) return true;
        var cfg = readPluginConfig(id);
        if (!cfg) return true;                    // can't read → keep (safe default)
        return cfg.enabled !== false;             // false removes; anything else keeps
    });
}

// When serving a plugin's config.json, apply the "enabled" array override so
// EditorsSupport matches what the plugin itself declares.
// If "enabled" is absent, true, or false this is a no-op (false is already
// filtered from the index before we ever get here).
function applyEditorsOverride(configText) {
    try {
        var obj = JSON.parse(configText);
        if (!Array.isArray(obj.enabled)) return configText;   // nothing to override
        var editors = obj.enabled;
        if (obj.variations) {
            obj.variations.forEach(function (v) { v.EditorsSupport = editors; });
        }
        return JSON.stringify(obj, null, 4);
    } catch (e) { return configText; }
}

http.createServer(function (req, res) {
    var parsed = url.parse(req.url);

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders()); res.end(); return;
    }

    var headers = corsHeaders();

    // ── /plugins-index.json — filter disabled plugins, rewrite URLs ──
    if (parsed.pathname === '/plugins-index.json') {
        var indexPath = path.join(ROOT, 'plugins-index.json');
        fs.readFile(indexPath, 'utf8', function (err, data) {
            if (err) { res.writeHead(500); res.end('Error reading plugins-index.json'); return; }
            var filtered = buildIndex(JSON.parse(data));
            var body     = localizeJson(JSON.stringify(filtered, null, 2));
            headers['Content-Type'] = 'application/json';
            res.writeHead(200, headers);
            res.end(body);
        });
        return;
    }

    // ── Static files ──────────────────────────────────────────
    var filePath = path.join(ROOT, parsed.pathname);

    // Security: stay inside ROOT
    if (filePath.indexOf(ROOT) !== 0) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.stat(filePath, function (err, stat) {
        if (err || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found: ' + parsed.pathname);
            return;
        }

        var ext  = path.extname(filePath).toLowerCase();
        var mime = MIME[ext] || 'application/octet-stream';
        headers['Content-Type'] = mime;

        // JSON: rewrite GitHub URLs; for config.json also apply editors override
        if (ext === '.json') {
            fs.readFile(filePath, 'utf8', function (e, data) {
                if (e) { res.writeHead(500); res.end('Read error'); return; }
                var out = localizeJson(data);
                if (path.basename(filePath) === 'config.json') {
                    out = applyEditorsOverride(out);
                }
                res.writeHead(200, headers);
                res.end(out);
            });
        } else {
            res.writeHead(200, headers);
            fs.createReadStream(filePath).pipe(res);
        }
    });
}).listen(PORT, '127.0.0.1', function () {
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────┐');
    console.log('  │  Plugin dev server → http://localhost:' + PORT + '           │');
    console.log('  └─────────────────────────────────────────────────────┘');
    console.log('');
    console.log('  In Sarv Office → Plugin Manager, set the index URL to:');
    console.log('  http://localhost:' + PORT + '/plugins-index.json');
    console.log('');
    console.log('  All ' + countPlugins() + ' plugins are served locally.');
    console.log('  Close + reopen a plugin panel to pick up JS/CSS changes.');
    console.log('');
});

function countPlugins() {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins-index.json'), 'utf8')).length;
    } catch (e) { return '?'; }
}
