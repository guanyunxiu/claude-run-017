/* eslint-disable @typescript-eslint/no-explicit-any */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';

describe('ProjectsService.removeMember live-session kick', () => {
  function makeService(extra: { findMember?: any; deleteCount?: number } = {}) {
    const kicked: Array<{ user: string; reason: string }> = [];
    const prisma = {
      project: {
        findUnique: async () => ({ id: 'p1', ownerId: 'owner' }),
      },
      projectMember: {
        findUnique: async () =>
          extra.findMember === undefined
            ? { userId: 'victim', projectId: 'p1' }
            : extra.findMember,
        deleteMany: async () => ({ count: extra.deleteCount ?? 1 }),
      },
    };
    const permissions = {
      requireAtLeast: jest.fn(async () => undefined),
    };
    const liveSessions = {
      kick: jest.fn(async (user: string, reason: string) => {
        kicked.push({ user, reason });
        return 1;
      }),
    };
    const service = new ProjectsService(
      prisma as any,
      permissions as any,
      liveSessions as any,
    );
    return { service, liveSessions, kicked, permissions };
  }

  it('kicks the removed user live sessions after a successful deletion', async () => {
    const { service, liveSessions } = makeService();
    await service.removeMember('p1', 'owner', 'm-victim');
    expect(liveSessions.kick).toHaveBeenCalledTimes(1);
    const [user, reason] = liveSessions.kick.mock.calls[0];
    expect(user).toBe('victim');
    expect(String(reason)).toMatch(/removed/i);
  });

  it('does not kick when the membership does not exist (no phantom disconnect)', async () => {
    const { service, liveSessions } = makeService({
      findMember: { userId: 'victim', projectId: 'p1' },
      deleteCount: 0,
    });
    await expect(
      service.removeMember('p1', 'owner', 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(liveSessions.kick).not.toHaveBeenCalled();
  });

  it('refuses to remove the owner before touching anything', async () => {
    const prisma = {
      project: {
        findUnique: async () => ({ id: 'p1', ownerId: 'owner' }),
      },
      projectMember: {
        findUnique: async () => {
          throw new Error('should not be called');
        },
        deleteMany: async () => {
          throw new Error('should not be called');
        },
      },
    };
    const service = new ProjectsService(
      prisma as any,
      { requireAtLeast: async () => undefined } as any,
      { kick: jest.fn() } as any,
    );
    // memberId === ownerId triggers the owner guard
    await expect(
      service.removeMember('p1', 'owner', 'owner'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
