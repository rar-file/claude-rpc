// Composes the local web dashboard's HTML from three on-disk assets:
//   assets/dashboard.html       — scaffold with {{STYLES}} {{SCRIPT}} {{PORT}}
//   assets/dashboard.css        — stylesheet
//   assets/dashboard.client.js  — vanilla browser runtime (one IIFE)
//
// These are real files you edit with full CSS/HTML/JS tooling — the reason
// this module shrank from a 1,200-line string monolith. loadAsset() reads
// them from disk in dev/npm and from the SEA blob in the packaged exe
// (see src/server/assets.js + sea-config.json).
//
// Single export: buildHtml({ port }). The server composes it once at
// startup and reuses the string for every request.

import { loadAsset } from './assets.js';

// Read once at module load. The assets are static for the life of the
// process; only `port` varies, and that's injected per buildHtml call.
const TEMPLATE = loadAsset('dashboard.html');
const STYLES   = loadAsset('dashboard.css');
const SCRIPT   = loadAsset('dashboard.client.js');

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

export { buildHtml };
