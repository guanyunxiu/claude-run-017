import { Role } from '@prisma/client';

export type ProjectRole = Role;

/**
 * Resolves a user's effective role for a project.
 * Membership table is authoritative; the project owner is always "owner"
 * even without an explicit membership row.
 */
export const ROLE_LEVEL: Record<ProjectRole, number> = {
  viewer: 0,
  editor: 1,
  owner: 2,
};
