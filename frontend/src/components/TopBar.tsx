import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function Avatar({
  name,
  color,
  size,
  title,
}: {
  name: string;
  color: string;
  size?: number;
  title?: string;
}) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span
      className="avatar"
      title={title ?? name}
      style={{
        background: color,
        width: size ?? 24,
        height: size ?? 24,
        fontSize: (size ?? 24) * 0.45,
      }}
    >
      {initials}
    </span>
  );
}

export default function TopBar({
  title,
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="topbar">
      <span
        className="brand"
        style={{ cursor: 'pointer' }}
        onClick={() => navigate('/')}
      >
        ⌗ CollabEditor
      </span>
      {title && <span className="muted">/ {title}</span>}
      <div className="spacer" />
      {children}
      {user && (
        <div className="me">
          <Avatar name={user.name} color={user.color} />
          <span>{user.name}</span>
          <button
            className="secondary"
            data-testid="logout-button"
            onClick={() => {
              logout();
              navigate('/login');
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
