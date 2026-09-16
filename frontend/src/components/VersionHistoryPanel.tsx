import { useCallback, useEffect, useState } from 'react';
import {
  listFileVersions,
  previewFileVersion,
  restoreFileVersion,
  type FileVersionPreview,
  type FileVersionSummary,
} from '../api/versions';
import { ApiError } from '../api/client';

interface Props {
  fileId: string;
  /** Project role of the current user; only owners can restore. */
  role: 'owner' | 'editor' | 'viewer';
  onClose: () => void;
  onRestored?: () => void;
}

export function VersionHistoryPanel({ fileId, role, onClose, onRestored }: Props) {
  const [versions, setVersions] = useState<FileVersionSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<FileVersionPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadingList(true);
    setLoadError(null);
    try {
      const res = await listFileVersions(fileId);
      setVersions(res.versions);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load versions');
    } finally {
      setLoadingList(false);
    }
  }, [fileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectVersion = useCallback(
    async (version: number) => {
      setSelected(version);
      setPreview(null);
      setActionError(null);
      setConfirming(false);
      setLoadingPreview(true);
      try {
        const p = await previewFileVersion(fileId, version);
        setPreview(p);
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : 'Failed to load preview',
        );
      } finally {
        setLoadingPreview(false);
      }
    },
    [fileId],
  );

  const doRestore = useCallback(async () => {
    if (selected === null) return;
    setRestoring(true);
    setActionError(null);
    try {
      await restoreFileVersion(fileId, selected);
      onRestored?.();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setActionError('Only the project owner can restore versions.');
      } else {
        setActionError(err instanceof Error ? err.message : 'Restore failed');
      }
      setRestoring(false);
      setConfirming(false);
    }
  }, [fileId, selected, onClose, onRestored]);

  return (
    <div className="version-panel">
      <div className="version-panel__header">
        <strong>Version history</strong>
        <button className="btn-ghost" onClick={onClose} aria-label="Close history">
          ✕
        </button>
      </div>

      {loadingList && <div className="version-panel__hint">Loading versions…</div>}
      {loadError && <div className="error-banner">{loadError}</div>}
      {!loadingList && versions.length === 0 && !loadError && (
        <div className="version-panel__hint">
          No snapshots yet. Versions appear after documents are compacted.
        </div>
      )}

      <div className="version-panel__body">
        <ul className="version-list">
          {versions.map((v) => (
            <li key={v.version}>
              <button
                className={`version-item${selected === v.version ? ' version-item--active' : ''}`}
                onClick={() => void selectVersion(v.version)}
              >
                <span className="version-item__number">v{v.version}</span>
                <span className="version-item__meta">
                  {new Date(v.createdAt).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="version-preview">
          {selected === null && (
            <div className="version-panel__hint">Select a version to preview its content.</div>
          )}
          {loadingPreview && <div className="version-panel__hint">Loading preview…</div>}
          {actionError && <div className="error-banner">{actionError}</div>}
          {preview && !confirming && (
            <>
              <div className="version-preview__head">
                <span>Preview v{preview.version}</span>
                <span className="muted">{preview.language}</span>
              </div>
              <pre className="version-preview__content">{preview.content || '(empty)'}</pre>
              {role === 'owner' ? (
                <button
                  className="btn-primary"
                  onClick={() => setConfirming(true)}
                >
                  Restore this version
                </button>
              ) : (
                <div className="muted" style={{ fontSize: 12 }}>
                  Only the project owner can restore.
                </div>
              )}
            </>
          )}
          {preview && confirming && (
            <div className="restore-confirm">
              <p>
                Restore the document to <strong>v{preview.version}</strong>?
              </p>
              <p className="muted" style={{ fontSize: 12 }}>
                Everyone currently editing will immediately see the older
                content. Changes made after this snapshot are replaced (a new
                snapshot of the restored state is kept).
              </p>
              <div className="restore-confirm__actions">
                <button
                  className="btn-danger"
                  disabled={restoring}
                  onClick={() => void doRestore()}
                >
                  {restoring ? 'Restoring…' : 'Confirm restore'}
                </button>
                <button
                  className="btn-ghost"
                  disabled={restoring}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
