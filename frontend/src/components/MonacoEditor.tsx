import { useEffect, useRef } from 'react';
import type * as MonacoType from 'monaco-editor';
import { MonacoBinding } from 'y-monaco';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { configureMonaco } from '../editor/monaco-setup';

interface Props {
  ydoc: Y.Doc;
  awareness: Awareness;
  language: string;
  path: string;
  readOnly: boolean;
  onEditorReady?: (editor: MonacoType.editor.IStandaloneCodeEditor) => void;
}

export default function MonacoEditor({
  ydoc,
  awareness,
  language,
  path,
  readOnly,
  onEditorReady,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<MonacoType.editor.ITextModel | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);

  // Create the editor once.
  useEffect(() => {
    const monaco = configureMonaco();
    if (!hostRef.current) return;

    const model = monaco.editor.createModel('', language, monaco.Uri.parse(`inmemory:///${path}`));
    modelRef.current = model;

    const editor = monaco.editor.create(hostRef.current, {
      model,
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      readOnly,
      domReadOnly: readOnly,
    });
    editorRef.current = editor;
    onEditorReady?.(editor);

    return () => {
      bindingRef.current?.destroy();
      bindingRef.current = null;
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // Editor lifetime is bound to the open file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bind the Yjs text to the Monaco model.
  useEffect(() => {
    if (!editorRef.current || !modelRef.current) return;
    const type = ydoc.getText('content');
    const binding = new MonacoBinding(
      type,
      modelRef.current,
      new Set([editorRef.current]),
      awareness,
    );
    bindingRef.current = binding;
    return () => {
      binding.destroy();
      bindingRef.current = null;
    };
  }, [ydoc, awareness]);

  // React to read-only / language changes without recreating the editor.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly });
  }, [readOnly]);

  useEffect(() => {
    const monaco = configureMonaco();
    const model = modelRef.current;
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  return <div className="monaco-host" data-testid="monaco-host" ref={hostRef} />;
}
