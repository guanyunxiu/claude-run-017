import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TopBar from '../components/TopBar';
import { api, ApiError } from '../api/client';
import { useToast } from '../components/Toast';
import type { Project, Role } from '../types';

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  async function load() {
    try {
      setProjects(await api.get<Project[]>('/projects'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load projects');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createProject(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const project = await api.post<Project>('/projects', { name: name.trim() });
      setName('');
      toast.success('Project created');
      navigate(`/projects/${project.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to create project');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="shell">
      <TopBar />
      <div className="centered">
        <h2 style={{ marginTop: 0 }}>Your projects</h2>
        <form className="row" onSubmit={createProject}>
          <input
            data-testid="new-project-name"
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: 320 }}
          />
          <button
            data-testid="new-project-submit"
            type="submit"
            disabled={creating || !name.trim()}
          >
            {creating ? 'Creating…' : 'Create project'}
          </button>
        </form>

        {projects === null ? (
          <p className="muted mt-24">
            <span className="spinner" /> Loading…
          </p>
        ) : projects.length === 0 ? (
          <p className="muted mt-24">
            No projects yet. Create your first one above.
          </p>
        ) : (
          <div className="project-grid">
            {projects.map((p) => (
              <div
                key={p.id}
                className="project-card"
                data-testid={`project-card-${p.id}`}
                onClick={() => navigate(`/projects/${p.id}`)}
              >
                <h3>{p.name}</h3>
                <div className="meta">
                  <span className={`badge ${p.role}`}>{ROLE_LABEL[p.role]}</span>{' '}
                  · {p.fileCount ?? 0} files · {p.members.length + 1} members
                </div>
                <div className="meta mt-12">Owner: {p.owner.name}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
