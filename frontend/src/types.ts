export type Role = 'owner' | 'editor' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
  color: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface ProjectMember {
  id: string;
  role: Role;
  user: User;
}

export interface Project {
  id: string;
  name: string;
  ownerId: string;
  owner: User;
  role: Role;
  fileCount?: number;
  members: ProjectMember[];
  createdAt: string;
  updatedAt: string;
}

export interface FileNode {
  id: string;
  projectId: string;
  name: string;
  path: string;
  language: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export interface MemberRow {
  id: string;
  email: string;
  name: string;
  color: string;
  role: Role;
  joinedAt: string;
}

export interface PresenceUser {
  clientId: number;
  userId: string;
  name: string;
  color: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
