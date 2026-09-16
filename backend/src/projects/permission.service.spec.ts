import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PermissionService } from './permission.service';

describe('PermissionService', () => {
  const project = { id: 'p1', ownerId: 'owner-1' };
  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === project.id ? project : null,
      ),
    },
    projectMember: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { projectId_userId: { projectId: string; userId: string } };
        }) => {
          const map: Record<string, 'editor' | 'viewer'> = {
            'p1:editor-1': 'editor',
            'p1:viewer-1': 'viewer',
          };
          const key = `${where.projectId_userId.projectId}:${where.projectId_userId.userId}`;
          return map[key] ? { role: map[key] } : null;
        },
      ),
    },
    file: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'f1' ? { id: 'f1', projectId: 'p1' } : null,
      ),
    },
  };

  let service: PermissionService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new PermissionService(prisma as never);
  });

  it('treats the owner as owner', async () => {
    expect(await service.getProjectRole('p1', 'owner-1')).toBe('owner');
  });

  it('resolves member roles from the membership table', async () => {
    expect(await service.getProjectRole('p1', 'editor-1')).toBe('editor');
    expect(await service.getProjectRole('p1', 'viewer-1')).toBe('viewer');
    expect(await service.getProjectRole('p1', 'stranger')).toBeNull();
  });

  it('returns null for a missing project', async () => {
    expect(await service.getProjectRole('nope', 'u')).toBeNull();
  });

  it('requireAtLeast enforces the role hierarchy', async () => {
    await expect(
      service.requireAtLeast('p1', 'viewer-1', 'editor'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.requireAtLeast('p1', 'editor-1', 'owner'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.requireAtLeast('p1', 'owner-1', 'owner')).resolves.toBe(
      'owner',
    );
  });

  it('throws NotFound for unknown projects and Forbidden for non-members', async () => {
    await expect(service.requireProjectRole('nope', 'u')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.requireProjectRole('p1', 'stranger'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('resolves a file role through the parent project', async () => {
    const result = await service.getFileRole('f1', 'editor-1');
    expect(result?.role).toBe('editor');
    expect(result?.file.projectId).toBe('p1');
    expect(await service.getFileRole('missing', 'u')).toBeNull();
  });

  it('requireFileRole rejects a file that does not exist or no access', async () => {
    await expect(
      service.requireFileRole('missing', 'u'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
