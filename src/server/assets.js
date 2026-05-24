// Loads the dashboard's browser assets (CSS / HTML / client JS).
//
// Three runtime modes, two storage strategies:
//   dev + npm-install  → the files sit on disk under ./assets/; read them.
//   packaged SEA exe   → there is no filesystem beside the binary, so the
//                        files are baked into the SEA blob (see the `assets`
//                        map in sea-config.json) and pulled out at runtime
//                        via node:sea getAsset().
//
// node:sea exists only on Node 20.12+, and isSea() is false unless we're
// actually inside a packaged binary — so a guarded require keeps the
// Node 18 dev/npm path working and falls through to disk reads everywhere
// that isn't a real SEA.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets');

let seaApi;
function sea() {
  if (seaApi !== undefined) return seaApi;
  try { seaApi = createRequire(import.meta.url)('node:sea'); }
  catch { seaApi = null; } // node:sea absent (Node < 20.12) — disk path only
  return seaApi;
}

export function loadAsset(name) {
  const s = sea();
  if (s && typeof s.isSea === 'function' && s.isSea()) {
    return s.getAsset(name, 'utf8');
  }
  return readFileSync(join(ASSET_DIR, name), 'utf8');
}
