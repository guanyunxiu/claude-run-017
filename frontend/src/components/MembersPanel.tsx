import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { MemberRow, Role } from '../types';
import { useToast } from './Toast';

interface Props {
  projectId: string;
  myRole: Role;
  members: MemberRow[];
  onChanged: () => void;
}

export default function MembersPanel({
  projectId,
  myRole,
  members,
  onChanged,
}: Props) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [busy, setBusy] = useState(false);
  const isOwner = myRole === 'owner';

  async function addMember(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      await api.post(`/projects/${projectId}/members`, {
        email: email.trim(),
        role,
      });
      setEmail('');
      toast.success('Member added');
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to add member');
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(memberId: string, next: 'editor' | 'viewer') {
    try {
      await api.patch(`/projects/${projectId}/members/${memberId}`, {
        role: next,
      });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update role');
    }
  }

  async function remove(memberId: string) {
    if (!window.confirm('Remove this member from the project?')) return;
    try {
      await api.del(`/projects/${projectId}/members/${memberId}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove member');
    }
  }

  return (
    <aside className="members-panel">
      <div className="sidebar-section">
        <span>Members</span>
      </div>
      {members.map((m) => (
        <div className="member-row" key={m.id} data-testid={`member-${m.id}`}>
          <span
            className="mini-avatar"
            style={{ background: m.color }}
            title={m.email}
          >
            {m.name.slice(0, 2).toUpperCase()}
          </span>
          <span className="name">
            {m.name}
            <div className="muted" style={{ fontSize: 11 }}>
              {m.email}
            </div>
          </span>
          {isOwner && m.role !== 'owner' ? (
            <select
              data-testid={`role-select-${m.id}`}
              value={m.role}
              onChange={(e) =>
                changeRole(m.id, e.target.value as 'editor' | 'viewer')
              }
            >
              <option value="editor">editor</option>
              <option value="viewer">viewer</option>
            </select>
          ) : (
            <span className={`badge ${m.role}`}>{m.role}</span>
          )}
          {isOwner && m.role !== 'owner' && (
            <button
              className="icon danger"
              title="Remove member"
              data-testid={`remove-member-${m.id}`}
              onClick={() => remove(m.id)}
            >
              ✕
            </button>
          )}
        </div>
      ))}

      {isOwner && (
        <form onSubmit={addMember} style={{ padding: '10px 12px' }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            Add by registered email
          </div>
          <input
            data-testid="member-email"
            type="email"
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: '100%', marginBottom: 6 }}
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <select
              data-testid="member-role"
              value={role}
              onChange={(e) =>
                setRole(e.target.value as 'editor' | 'viewer')
              }
            >
              <option value="editor">editor</option>
              <option value="viewer">viewer</option>
            </select>
            <button
              data-testid="member-add-submit"
              type="submit"
              disabled={busy || !email.trim()}
            >
              Add
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}
