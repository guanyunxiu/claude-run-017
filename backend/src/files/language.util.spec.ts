import { inferLanguage, normalizePath } from './language.util';

describe('inferLanguage', () => {
  it('maps common TypeScript / JavaScript extensions', () => {
    expect(inferLanguage('a.ts')).toBe('typescript');
    expect(inferLanguage('component.tsx')).toBe('typescript');
    expect(inferLanguage('b.js')).toBe('javascript');
    expect(inferLanguage('b.jsx')).toBe('javascript');
  });

  it('maps several backend languages', () => {
    expect(inferLanguage('main.go')).toBe('go');
    expect(inferLanguage('lib.py')).toBe('python');
    expect(inferLanguage('server.rs')).toBe('rust');
    expect(inferLanguage('query.sql')).toBe('sql');
  });

  it('handles dockerfiles and special basenames', () => {
    expect(inferLanguage('Dockerfile')).toBe('dockerfile');
    expect(inferLanguage('Makefile')).toBe('makefile');
  });

  it('falls back to plaintext', () => {
    expect(inferLanguage('README')).toBe('plaintext');
    expect(inferLanguage('notes.unknownext')).toBe('plaintext');
  });
});

describe('normalizePath', () => {
  it('joins directory and name with a slash', () => {
    expect(normalizePath('src', 'index.ts')).toBe('src/index.ts');
  });

  it('handles root files', () => {
    expect(normalizePath('', 'README.md')).toBe('README.md');
    expect(normalizePath(undefined, 'README.md')).toBe('README.md');
  });

  it('strips leading/trailing slashes and collapses duplicates', () => {
    expect(normalizePath('/src//', 'a.ts')).toBe('src/a.ts');
  });
});
