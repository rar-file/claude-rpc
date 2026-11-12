// Composes the local web dashboard's pages from on-disk assets (plus the
// settings.html / settings.css / settings.client.js trio for /settings):
//   assets/dashboard.html       — scaffold with {{STYLES}} {{SCRIPT}} {{PORT}}
//   assets/dashboard.css        — stylesheet
//   assets/dashboard.client.js  — vanilla browser runtime (one IIFE)
//   assets/wrapped.html         — /wrapped scaffold with {{STYLES}} {{SCRIPT}}
//   assets/wrapped.css          — /wrapped stylesheet
//   assets/wrapped.client.js    — /wrapped story runtime (one IIFE)
//
// These are real files you edit with full CSS/HTML/JS tooling — the reason
// this module shrank from a 1,200-line string monolith. loadAsset() reads
// them from disk in dev/npm and from the SEA blob in the packaged exe
// (see src/server/assets.js + sea-config.json).
//
// Exports buildHtml({ port }), buildWrappedHtml() and buildSettingsHtml(). The server
// composes each once at startup and reuses the string for every request.

import { loadAsset } from './assets.js';

// Read once at module load. The assets are static for the life of the
// process; only `port` varies, and that's injected per buildHtml call.
const TEMPLATE = loadAsset('dashboard.html');
const STYLES   = loadAsset('dashboard.css');
const SCRIPT   = loadAsset('dashboard.client.js');

const SETTINGS_TEMPLATE = loadAsset('settings.html');
const SETTINGS_STYLES   = loadAsset('settings.css');
const SETTINGS_SCRIPT   = loadAsset('settings.client.js');

const WRAPPED_TEMPLATE = loadAsset('wrapped.html');
const WRAPPED_STYLES   = loadAsset('wrapped.css');
const WRAPPED_SCRIPT   = loadAsset('wrapped.client.js');

function buildHtml({ port }) {
  // Replacer FUNCTIONS, not strings: the client JS is full of `$(id)` DOM
  // accessors and the CSS could carry `$`, both of which String.prototype
  // .replace treats as special replacement patterns when passed as a
  // string. A function replacer inserts the value verbatim.
  return TEMPLATE
    .replace('{{STYLES}}', () => STYLES)
    .replace('{{SCRIPT}}', () => SCRIPT)
    .replaceAll('{{PORT}}', String(port));
}

// The animated /wrapped year-in-review. Same compose-once pattern.
function buildWrappedHtml() {
  return WRAPPED_TEMPLATE
    .replace('{{STYLES}}', () => WRAPPED_STYLES)
    .replace('{{SCRIPT}}', () => WRAPPED_SCRIPT);
}

// /settings — config editor, daemon controls, per-project privacy. Shares the
// dashboard's stylesheet (tokens, type, buttons) and adds its own on top.
function buildSettingsHtml({ port }) {
  return SETTINGS_TEMPLATE
    .replace('{{STYLES}}', () => STYLES + '\n' + SETTINGS_STYLES)
    .replace('{{SCRIPT}}', () => SETTINGS_SCRIPT)
    .replaceAll('{{PORT}}', String(port));
}

export { buildHtml, buildWrappedHtml, buildSettingsHtml };
