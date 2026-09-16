/* eslint-disable @typescript-eslint/no-explicit-any */
import { ForbiddenException } from '@nestjs/common';
import * as Y from 'yjs';
import { FilesService } from './files.service';
import { PermissionService } from '../projects/permission.service';

class FakePrisma {
  projects: any[] = [{ id: 'p1', ownerId: 'owner-1' }];
  members: any[] = [
    { id: 'm1', projectId: 'p1', userId: 'editor-1', role: 'editor' },
    { id: 'm2', projectId: 'p1', userId: 'viewer-1', role: 'viewer' },
  ];
  files: any[] = [];
  updates: any[] = [];
  private fileSeq = 0;
  private updateSeq = 1n;

  project = {
    findUnique: async ({ where }: any) =>
      this.projects.find((p) => p.id === where.id) ?? null,
  };

  projectMember = {
    findUnique: async ({ where }: any) =>
      this.members.find(
        (m) =>
          m.projectId === where.projectId_userId.projectId &&
          m.userId === where.projectId_userId.userId,
      ) ?? null,
  };

  file = {
    findMany: async ({ where }: any) =>
      this.files.filter((f) => f.projectId === where.projectId),
    findUnique: async ({ where }: any) =>
      this.files.find((f) => f.id === where.id) ?? null,
    findUniqueOrThrow: async ({ where }: any) => {
      const f = this.files.find((x) => x.id === where.id);
      if (!f) throw new Error('not found');
      return f;
    },
    create: async ({ data }: any) => {
      const row = {
        id: `f${++this.fileSeq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.files.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const f = this.files.find((x) => x.id === where.id);
      Object.assign(f as any, data);
      return f;
    },
    delete: async ({ where }: any) => {
      this.files = this.files.filter((f) => f.id !== where.id);
      return {};
    },
  };

  documentUpdate = {
    create: async ({ data }: any) => {
      const row = { id: this.updateSeq++, ...data };
      this.updates.push(row);
      return { id: row.id };
    },
    findMany: async ({ where }: any) =>
      this.updates
        .filter((u: any) => u.fileId === where.fileId)
        .sort((a: any, b: any) => (a.id < b.id ? -1 : 1)),
  };

  fileSnapshot = {
    findFirst: async () => null,
    create: async () => ({}),
  };
}

class FakeStorage {
  async getSnapshot(): Promise<Uint8Array> {
    throw new Error('no snapshots in this test');
  }
}

function makeService() {
  const prisma = new FakePrisma();
  const permissions = new PermissionService(prisma as any);
  const service = new FilesService(
    prisma as any,
    permissions,
    new FakeStorage() as any,
  );
  return { service, prisma };
}

describe('FilesService', () => {
  it('creates a file with inferred language and seeds an empty CRDT update', async () => {
    const { service, prisma } = makeService();
    const file = await service.create('p1', 'editor-1', {
      name: 'app.ts',
      path: 'src',
    });
    expect(file.language).toBe('typescript');
    expect(file.path).toBe('src/app.ts');
    expect(prisma.updates).toHaveLength(1);
  });

  it('lists files and includes the callers effective role', async () => {
    const { service } = makeService();
    await service.create('p1', 'editor-1', { name: 'a.ts' });
    const viewerList = await service.list('p1', 'viewer-1');
    const ownerList = await service.list('p1', 'owner-1');
    expect(viewerList[0].role).toBe('viewer');
    expect(ownerList[0].role).toBe('owner');
  });

  it('forbids viewers from creating, renaming and deleting files', async () => {
    const { service } = makeService();
    await expect(
      service.create('p1', 'viewer-1', { name: 'a.ts' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const file = await service.create('p1', 'editor-1', { name: 'a.ts' });
    await expect(
      service.rename(file.id, 'viewer-1', { name: 'b.ts' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove(file.id, 'viewer-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('reads back content decoded from persisted Yjs updates', async () => {
    const { service, prisma } = makeService();
    const file = await service.create('p1', 'editor-1', { name: 'note.md' });

    const doc = new Y.Doc();
    doc.getText('content').insert(0, '# Hello CRDT\n');
    await prisma.documentUpdate.create({
      data: {
        fileId: file.id,
        update: Buffer.from(Y.encodeStateAsUpdate(doc)),
        sizeBytes: 0,
      },
    });

    const result = await service.readContent(file.id, 'viewer-1');
    expect(result.content).toBe('# Hello CRDT\n');
    expect(result.language).toBe('markdown');
  });

  it('renames a file and re-infers the language', async () => {
    const { service } = makeService();
    const file = await service.create('p1', 'editor-1', { name: 'a.txt' });
    const renamed = await service.rename(file.id, 'editor-1', { name: 'a.py' });
    expect(renamed.name).toBe('a.py');
    expect(renamed.language).toBe('python');
  });
});
