// File extension → language map. Used by the scanner to bucket edits by
// language and by the dashboards to show per-language totals.

const EXT_TO_LANG = {
  // Web / JS
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.vue': 'Vue', '.svelte': 'Svelte',
  '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'SCSS', '.sass': 'Sass', '.less': 'Less',
  '.json': 'JSON', '.jsonc': 'JSON', '.json5': 'JSON',

  // Backend / systems
  '.py': 'Python', '.pyi': 'Python', '.pyw': 'Python',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin', '.scala': 'Scala', '.groovy': 'Groovy',
  '.c': 'C', '.h': 'C',
  '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.hh': 'C++', '.hxx': 'C++',
  '.cs': 'C#',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.m': 'Objective-C', '.mm': 'Objective-C++',
  '.zig': 'Zig',
  '.lua': 'Lua',
  '.dart': 'Dart',
  '.elm': 'Elm',
  '.ex': 'Elixir', '.exs': 'Elixir',
  '.erl': 'Erlang',
  '.hs': 'Haskell',
  '.ml': 'OCaml', '.mli': 'OCaml',
  '.clj': 'Clojure', '.cljs': 'ClojureScript',
  '.r': 'R', '.R': 'R',
  '.jl': 'Julia',
  '.nim': 'Nim',
  '.cr': 'Crystal',
  '.v': 'V',

  // Shell / config
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.fish': 'Shell',
  '.ps1': 'PowerShell', '.psm1': 'PowerShell',
  '.bat': 'Batch', '.cmd': 'Batch',
  '.yml': 'YAML', '.yaml': 'YAML',
  '.toml': 'TOML',
  '.ini': 'INI', '.cfg': 'INI', '.conf': 'INI',
  '.env': 'Env',
  '.xml': 'XML',
  '.dockerfile': 'Dockerfile',

  // Docs
  '.md': 'Markdown', '.mdx': 'Markdown', '.markdown': 'Markdown',
  '.rst': 'reStructuredText',
  '.tex': 'LaTeX',
  '.txt': 'Text',

  // Data / queries
  '.sql': 'SQL',
  '.graphql': 'GraphQL', '.gql': 'GraphQL',
  '.proto': 'Protobuf',

  // Notebooks
  '.ipynb': 'Notebook',

  // Build / lock
  '.lock': 'Lockfile',
  '.gradle': 'Gradle',
  '.cmake': 'CMake',
  '.make': 'Make',
  '.mk': 'Make',

  // Mobile / native
  '.xib': 'Interface Builder',
  '.storyboard': 'Interface Builder',

  // Misc
  '.gitignore': 'Git',
  '.gitattributes': 'Git',
};

// Filenames without extension that we still want to classify.
const FILENAME_TO_LANG = {
  'Dockerfile': 'Dockerfile',
  'Makefile': 'Make',
  'GNUmakefile': 'Make',
  'Rakefile': 'Ruby',
  'Gemfile': 'Ruby',
  'Procfile': 'Config',
  'CMakeLists.txt': 'CMake',
  'package.json': 'JSON',
  'tsconfig.json': 'JSON',
};

function fileBasename(path) {
  const norm = String(path || '').replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function fileExt(path) {
  const base = fileBasename(path);
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx).toLowerCase();
}

export function languageOf(path) {
  if (!path) return null;
  const base = fileBasename(path);
  if (FILENAME_TO_LANG[base]) return FILENAME_TO_LANG[base];
  const ext = fileExt(path);
  return EXT_TO_LANG[ext] || null;
}
