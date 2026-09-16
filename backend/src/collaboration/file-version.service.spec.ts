/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Y from 'yjs';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FileVersionService } from './file-version.service';

function snapshotBytes(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText('content').insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

function makeService(role: 'owner' | 'editor' | 'viewer' | null) {
  const snapshot = {
    id: 'snap-1',
    fileId: 'f1',
    version: 3,
    s3Key: 'snapshots/f1/v3.bin',
    lastUpdateId: 10,
    sizeBytes: 42,
    createdAt: new Date(0),
  };
  const prisma = {
    fileSnapshot: {
      findMany: async () => [snapshot],
      findFirst: async () => snapshot,
    },
    file: {
      findUnique: async () => ({ id: 'f1', language: 'typescript' }),
    },
  };
  const storage = {
    getSnapshot: async () => snapshotBytes('hello v3'),
  };
  const permissions = {
    requireFileRole: async () => ({
      role: role ?? 'viewer',
      file: { id: 'f1', projectId: 'p1' },
    }),
    getFileRole: async () =>
      role ? { role, file: { id: 'f1', projectId: 'p1' } } : null,
    getProjectRole: async () => role,
  };
  const restoreCalls: Array<{ fileId: string; version: number }> = [];
  const rooms = {
    restoreFileVersion: async (fileId: string, version: number) => {
      restoreCalls.push({ fileId, version });
      return { version: 4 };
    },
  };
  const service = new FileVersionService(
    prisma as any,
    storage as any,
    permissions as any,
    rooms as any,
  );
  return { service, restoreCalls };
}

describe('FileVersionService', () => {
  it('lists versions for any member', async () => {
    const { service } = makeService('viewer');
    const result = await service.listVersions('f1', 'u');
    expect(result.versions[0].version).toBe(3);
  });

  it('previews the decoded text of a version for a member', async () => {
    const { service } = makeService('editor');
    const preview = await service.previewVersion('f1', 3, 'u');
    expect(preview.content).toBe('hello v3');
    expect(preview.language).toBe('typescript');
  });

  it('404s when the previewed version does not exist', async () => {
    // role owner so we pass auth; snapshot missing via a null-returning service
    const prisma = {
      fileSnapshot: { findFirst: async () => null },
      file: { findUnique: async () => ({ id: 'f1', language: 'ts' }) },
    };
    const service = new FileVersionService(
      prisma as any,
      { getSnapshot: async () => new Uint8Array() } as any,
      {
        requireFileRole: async () => ({ role: 'owner', file: { id: 'f1' } }),
      } as any,
      { restoreFileVersion: async () => ({ version: 1 }) } as any,
    );
    await expect(service.previewVersion('f1', 99, 'u')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('allows the owner to restore and delegates to the room manager', async () => {
    const { service, restoreCalls } = makeService('owner');
    const result = await service.restoreVersion('f1', 3, 'u');
    expect(result).toEqual({ fileId: 'f1', version: 4 });
    expect(restoreCalls).toEqual([{ fileId: 'f1', version: 3 }]);
  });

  it('forbids non-owners from restoring (403)', async () => {
    for (const role of ['editor', 'viewer'] as const) {
      const { service, restoreCalls } = makeService(role);
      await expect(service.restoreVersion('f1', 3, 'u')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(restoreCalls).toHaveLength(0);
    }
  });
});
