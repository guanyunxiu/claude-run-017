import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import TopBar, { Avatar } from '../components/TopBar';
import FileTree from '../components/FileTree';
import MembersPanel from '../components/MembersPanel';
import MonacoEditor from '../components/MonacoEditor';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { useYFile } from '../editor/useYFile';
import type {
  FileNode,
  MemberRow,
  Project,
  SaveStatus,
} from '../types';

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'All changes saved',
  error: 'Save failed',
};

function formatTime(ts: number | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString();
}

export default function ProjectPage() {
  const { projectId = '' } = useParams();
  const { user } = useAuth();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<FileNode[] | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    try {
      const p = await api.get<Project>(`/projects/${projectId}`);
      setProject(p);
    } catch (err) {
      setLoadingError(
        err instanceof ApiError ? err.message : 'Failed to load project',
      );
    }
  }, [projectId]);

  const loadFiles = useCallback(async () => {
    try {
      setFiles(await api.get<FileNode[]>(`/projects/${projectId}/files`));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load files');
    }
  }, [projectId, toast]);

  const loadMembers = useCallback(async () => {
    try {
      setMembers(await api.get<MemberRow[]>(`/projects/${projectId}/members`));
    } catch {
      // members are secondary; ignore transient errors
    }
  }, [projectId]);

  useEffect(() => {
    void loadProject();
    void loadFiles();
    void loadMembers();
  }, [loadProject, loadFiles, loadMembers]);

  const activeFile = useMemo(
    () => files?.find((f) => f.id === activeFileId) ?? null,
    [files, activeFileId],
  );
  const myRole = project?.role ?? 'viewer';
  const canEdit = myRole !== 'viewer';

  const onPermissionDenied = useCallback(
    (reason: string) => {
      toast.error(reason);
    },
    [toast],
  );

  const collab = useYFile({
    fileId: activeFileId ?? '__none__',
    currentUser: user!,
    onPermissionDenied,
  });

  // Open file -------------------------------------------------------------
  function openFile(file: FileNode) {
    setActiveFileId(file.id);
  }

  // File CRUD -------------------------------------------------------------
  async function createFile(parentDir: string) {
    const name = window.prompt(
      parentDir ? `New file name in ${parentDir}:` : 'New file name:',
      'untitled.ts',
    );
    if (!name) return;
    try {
      await api.post(`/projects/${projectId}/files`, {
        name: name.trim(),
        path: parentDir || undefined,
      });
      toast.success(`Created ${name}`);
      await loadFiles();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to create file');
    }
  }

  async function renameFile(file: FileNode) {
    const name = window.prompt('Rename file to:', file.name);
    if (!name || name === file.name) return;
    try {
      await api.patch(`/files/${file.id}`, { name: name.trim() });
      toast.success('Renamed');
      await loadFiles();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to rename file');
    }
  }

  async function deleteFile(file: FileNode) {
    if (!window.confirm(`Delete ${file.path}? This cannot be undone.`)) return;
    try {
      await api.del(`/files/${file.id}`);
      toast.success('Deleted');
      if (activeFileId === file.id) setActiveFileId(null);
      await loadFiles();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete file');
    }
  }

  if (loadingError) {
    return (
      <div className="shell">
        <TopBar />
        <div className="centered">
          <h2>Could not open project</h2>
          <p className="error-banner">{loadingError}</p>
        </div>
      </div>
    );
  }
  if (!project || !files || !user) {
    return (
      <div className="shell">
        <TopBar />
        <div className="centered">
          <span className="spinner" /> Loading project…
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <TopBar title={project.name}>
        <span className={`badge ${project.role}`}>{project.role}</span>
      </TopBar>
      <div className="workspace">
        <nav className="sidebar">
          <div className="sidebar-section">
            <span>{project.name}</span>
          </div>
          <FileTree
            files={files}
            activeId={activeFileId}
            role={myRole}
            onOpen={openFile}
            onCreate={createFile}
            onRename={renameFile}
            onDelete={deleteFile}
          />
        </nav>

        <main className="main">
          {!activeFile ? (
            <div
              className="centered"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'column',
                color: 'var(--text-dim)',
              }}
            >
              <div style={{ fontSize: 40 }}>📄</div>
              <p>Select a file from the sidebar to start collaborating.</p>
              {canEdit && (
                <button data-testid="empty-create-file" onClick={() => createFile('')}>
                  Create a file
                </button>
              )}
            </div>
          ) : (
            <>
              {collab.ydoc && collab.provider && (
                <div className="editor-toolbar">
                  <strong data-testid="active-file-name">{activeFile.name}</strong>
                  <span className="file-path">{activeFile.path}</span>
                  <span className={`badge ${activeFile.language}`}>
                    {activeFile.language}
                  </span>
                  <span className="tabs-row">
                    <span
                      className="status-dot"
                      data-testid="connection-status"
                      title={collab.connection}
                    >
                      <span className={`dot ${collab.connection}`} />
                      {collab.connection === 'connected'
                        ? 'Connected'
                        : collab.connection === 'connecting'
                          ? 'Connecting…'
                          : 'Reconnecting…'}
                    </span>
                    <span className="muted" data-testid="save-status">
                      {STATUS_TEXT[collab.saveStatus]}
                      {collab.lastSavedAt
                        ? ` ${formatTime(collab.lastSavedAt)}`
                        : ''}
                    </span>
                    <button
                      className="secondary"
                      data-testid="reconnect-button"
                      onClick={() => collab.forceReconnect()}
                      title="Force reconnect"
                    >
                      ↻
                    </button>
                    <span
                      className="presence-list"
                      data-testid="presence-list"
                      title={`${collab.presentUsers.length} online`}
                    >
                      {collab.presentUsers.map((p) => (
                        <Avatar
                          key={`${p.clientId}-${p.userId}`}
                          name={p.name}
                          color={p.color}
                          title={`${p.name} online`}
                        />
                      ))}
                    </span>
                  </span>
                </div>
              )}
              {!canEdit && (
                <div className="readonly-note" data-testid="readonly-note">
                  You have viewer access. Editing is disabled, but you can follow
                  live changes and cursors.
                </div>
              )}
              <div className="editor-host">
                {collab.ydoc && collab.provider ? (
                  <MonacoEditor
                    key={activeFile.id}
                    ydoc={collab.ydoc}
                    awareness={collab.provider.awareness}
                    language={activeFile.language}
                    path={activeFile.path}
                    readOnly={!canEdit}
                  />
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      height: '100%',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <span className="spinner" />
                  </div>
                )}
              </div>
            </>
          )}
        </main>

        <MembersPanel
          projectId={projectId}
          myRole={myRole}
          members={members}
          onChanged={() => {
            void loadProject();
            void loadMembers();
          }}
        />
      </div>
    </div>
  );
}
