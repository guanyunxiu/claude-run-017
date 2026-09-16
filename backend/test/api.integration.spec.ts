/* eslint-disable @typescript-eslint/no-explicit-any */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/common/redis/redis.module';
import { StorageService } from '../src/storage/storage.service';

/**
 * HTTP-level integration test covering auth, projects, files and the role
 * checks through the real Nest router/guards/validation pipeline.
 * The database, Redis and S3 are in-memory fakes.
 */
class InMemoryPrisma {
  users: any[] = [];
  projects: any[] = [];
  members: any[] = [];
  files: any[] = [];
  updates: any[] = [];
  snapshots: any[] = [];
  private seq = 0;

  $connect = async () => undefined;
  $disconnect = async () => undefined;

  private id(prefix: string) {
    return `${prefix}-${++this.seq}`;
  }

  user = {
    findUnique: async ({ where }: any) =>
      this.users.find((u) =>
        where.email ? u.email === where.email : u.id === where.id,
      ) ?? null,
    create: async ({ data }: any) => {
      const row = {
        id: this.id('user'),
        color: '#123456',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.users.push(row);
      return row;
    },
  };

  private enrichProject(p: any, include: any) {
    if (!include) return p;
    const out: any = { ...p };
    if (include.owner) {
      out.owner = this.users.find((u) => u.id === p.ownerId) ?? null;
    }
    if (include.members) {
      out.members = this.members
        .filter((m) => m.projectId === p.id)
        .map((m) => ({
          ...m,
          user: this.users.find((u) => u.id === m.userId),
        }));
    }
    if (include._count) {
      out._count = {
        files: this.files.filter((f) => f.projectId === p.id).length,
      };
    }
    return out;
  }

  project = {
    create: async ({ data }: any) => {
      const row = {
        id: this.id('proj'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.projects.push(row);
      return row;
    },
    findUnique: async ({ where, include }: any) =>
      this.enrichProject(
        this.projects.find((p) => p.id === where.id) ?? null,
        include,
      ),
    findMany: async ({ where, include }: any) => {
      let rows = this.projects.slice();
      if (where?.ownerId) {
        rows = rows.filter((p) => p.ownerId === where.ownerId);
      } else if (where?.members?.some) {
        const userId = where.members.some.userId;
        rows = rows.filter(
          (p) =>
            p.ownerId !== userId &&
            this.members.some(
              (m) => m.projectId === p.id && m.userId === userId,
            ),
        );
      }
      return rows.map((p) => this.enrichProject(p, include));
    },
    update: async ({ where, data }: any) => {
      const p = this.projects.find((x) => x.id === where.id)!;
      Object.assign(p, data);
      return p;
    },
    delete: async ({ where }: any) => {
      this.projects = this.projects.filter((p) => p.id !== where.id);
      return {};
    },
  };

  projectMember = {
    findUnique: async ({ where }: any) =>
      this.members.find(
        (m) =>
          m.projectId === where.projectId_userId.projectId &&
          m.userId === where.projectId_userId.userId,
      ) ?? null,
    create: async ({ data }: any) => {
      const row = {
        id: this.id('member'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.members.push(row);
      return row;
    },
    update: async () => ({}),
    updateMany: async () => ({ count: 1 }),
    deleteMany: async ({ where }: any) => {
      const before = this.members.length;
      this.members = this.members.filter((m) => m.id !== where.id);
      return { count: before - this.members.length };
    },
  };

  file = {
    findMany: async ({ where }: any) =>
      this.files.filter((f) => f.projectId === where.projectId),
    findUnique: async ({ where }: any) =>
      this.files.find((f) => f.id === where.id) ?? null,
    findUniqueOrThrow: async ({ where }: any) =>
      this.files.find((f) => f.id === where.id),
    create: async ({ data }: any) => {
      const row = {
        id: this.id('file'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.files.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const f = this.files.find((x) => x.id === where.id)!;
      Object.assign(f, data);
      return f;
    },
    delete: async ({ where }: any) => {
      this.files = this.files.filter((f) => f.id !== where.id);
      return {};
    },
  };

  documentUpdate = {
    create: async ({ data }: any) => {
      const row = { id: BigInt(++this.seq), ...data };
      this.updates.push(row);
      return { id: row.id };
    },
    findMany: async ({ where }: any) =>
      this.updates
        .filter((u) => u.fileId === where.fileId)
        .sort((a: any, b: any) => (a.id < b.id ? -1 : 1)),
  };

  fileSnapshot = {
    findFirst: async () => null,
    findMany: async () => [] as any[],
    create: async () => ({}),
    count: async () => 0,
    deleteMany: async () => ({ count: 0 }),
  };
}

class FakeStorage {
  onModuleInit = async () => undefined;
}
class FakeRedis {
  on = () => this;
}

describe('REST API (HTTP integration)', () => {
  let app: INestApplication;
  let prisma: InMemoryPrisma;
  let ownerToken: string;
  let editorToken: string;
  let viewerToken: string;
  let projectId: string;

  beforeAll(async () => {
    prisma = new InMemoryPrisma();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new FakeRedis())
      .overrideProvider(StorageService)
      .useValue(new FakeStorage())
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const seedUser = async (email: string, name: string) => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, name, password: 'password123' })
      .expect(201);
    return res.body as { token: string; user: { id: string } };
  };

  it('registers, logs in and returns the current user', async () => {
    const owner = await seedUser('owner@x.com', 'Owner');
    ownerToken = owner.token;

    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(me.body.email).toBe('owner@x.com');

    await request(app.getHttpServer())
      .get('/api/auth/me')
      .expect(401);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'owner@x.com', password: 'password123' })
      .expect(201);
    expect(login.body.token).toBeTruthy();

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'owner@x.com', password: 'wrongpass' })
      .expect(401);
  });

  it('creates a project and adds editor + viewer members', async () => {
    const editor = await seedUser('editor@x.com', 'Editor');
    const viewer = await seedUser('viewer@x.com', 'Viewer');
    editorToken = editor.token;
    viewerToken = viewer.token;

    const created = await request(app.getHttpServer())
      .post('/api/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'P1' })
      .expect(201);
    projectId = created.body.id;

    await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'editor@x.com', role: 'editor' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'viewer@x.com', role: 'viewer' })
      .expect(201);

    const members = await request(app.getHttpServer())
      .get(`/api/projects/${projectId}/members`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    expect(members.body.map((m: any) => m.email).sort()).toEqual([
      'editor@x.com',
      'owner@x.com',
      'viewer@x.com',
    ]);
  });

  it('enforces file permissions end to end', async () => {
    // Viewer cannot create a file.
    await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/files`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'hack.ts' })
      .expect(403);

    const created = await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/files`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ name: 'main.ts', path: 'src' })
      .expect(201);
    expect(created.body.path).toBe('src/main.ts');
    const fileId = created.body.id;

    // A stranger cannot see the project at all.
    const stranger = await seedUser('stranger@x.com', 'Stranger');
    await request(app.getHttpServer())
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(403);

    // Viewer can read the file list and content metadata.
    await request(app.getHttpServer())
      .get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200)
      .expect((res) => expect(res.body.role).toBe('viewer'));

    // Viewer cannot rename or delete.
    await request(app.getHttpServer())
      .patch(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'renamed.ts' })
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);

    // Only the owner can manage members.
    await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/members`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ email: 'stranger@x.com', role: 'editor' })
      .expect(403);

    // Editor can rename.
    await request(app.getHttpServer())
      .patch(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ name: 'renamed.ts' })
      .expect(200);

    // ---- Version history endpoint permissions ----
    // Members can list (empty list on the in-memory fake).
    await request(app.getHttpServer())
      .get(`/api/files/${fileId}/versions`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200)
      .expect((res) => expect(Array.isArray(res.body.versions)).toBe(true));

    // Stranger cannot list versions.
    await request(app.getHttpServer())
      .get(`/api/files/${fileId}/versions`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);

    // Viewer cannot restore (owner-only), even though the version does not
    // exist: the role gate runs before snapshot lookup and returns 403.
    await request(app.getHttpServer())
      .post(`/api/files/${fileId}/versions/0/restore`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);

    // Editor cannot restore either.
    await request(app.getHttpServer())
      .post(`/api/files/${fileId}/versions/0/restore`)
      .set('Authorization', `Bearer ${editorToken}`)
      .expect(403);

    // Owner passes the role gate but gets 404 for the missing version.
    await request(app.getHttpServer())
      .post(`/api/files/${fileId}/versions/99/restore`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
  });

  it('rejects invalid input with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'not-an-email', name: 'X', password: '123' })
      .expect(400);
  });

  it('hashes passwords in the database', async () => {
    const row = prisma.users.find((u) => u.email === 'owner@x.com')!;
    expect(row.passwordHash).not.toBe('password123');
    expect(await bcrypt.compare('password123', row.passwordHash)).toBe(true);
  });
});
