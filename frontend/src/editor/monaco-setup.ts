import * as monaco from 'monaco-editor';
// Language workers - we only need the JSON/TS/CSS/HTML worker generically.
// Monaco's editor itself runs on the main thread; language services use workers.
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

let configured = false;

export function configureMonaco(): typeof monaco {
  if (configured) return monaco;
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };
  configured = true;
  // Exposed for E2E automation; harmless in production.
  (self as unknown as { monaco: typeof monaco }).monaco = monaco;
  return monaco;
}

export { monaco };
