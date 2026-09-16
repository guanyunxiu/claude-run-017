/**
 * Best-effort Monaco language identifier inference from a file name.
 * Monaco supports these IDs directly (vs.language.getLanguages()).
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  map: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  vue: 'html',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  clj: 'clojure',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  scala: 'scala',
  hs: 'haskell',
  txt: 'plaintext',
};

const BASENAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  'package.json': 'json',
  'tsconfig.json': 'json',
  makefile: 'makefile',
  '.gitignore': 'plaintext',
  '.env': 'ini',
};

export function inferLanguage(name: string): string {
  const lower = name.toLowerCase();
  if (BASENAME_LANGUAGE[lower]) return BASENAME_LANGUAGE[lower];
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const ext = lower.slice(dot + 1);
    if (EXTENSION_LANGUAGE[ext]) return EXTENSION_LANGUAGE[ext];
  }
  return 'plaintext';
}

/**
 * Normalize a file path. No leading slash; "/" is the root.
 */
export function normalizePath(input: string | undefined, name: string): string {
  const n = (name || '').trim();
  const raw = (input ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const base = raw ? `${raw}/${n}` : n;
  return base.replace(/\/+/g, '/');
}
