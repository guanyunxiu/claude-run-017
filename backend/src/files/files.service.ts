import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as Y from 'yjs';
import { PrismaService } from '../common/prisma/prisma.service';
import { PermissionService } from '../projects/permission.service';
import { StorageService } from '../storage/storage.service';
import { CreateFileDto } from './dto/create-file.dto';
import { UpdateFileDto } from './dto/update-file.dto';
import { inferLanguage, normalizePath } from './language.util';

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly storage: StorageService,
  ) {}

  private async ensureEditor(projectId: string, userId: string) {
    await this.permissions.requireAtLeast(projectId, userId, 'editor');
  }

  async list(projectId: string, userId: string) {
    const role = await this.permissions.requireProjectRole(projectId, userId);
    const files = await this.prisma.file.findMany({
      where: { projectId },
      orderBy: [{ path: 'asc' }, { name: 'asc' }],
    });
    return files.map((f) => ({
      id: f.id,
      projectId: f.projectId,
      name: f.name,
      path: f.path,
      language: f.language,
      role,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }));
  }

  async create(projectId: string, userId: string, dto: CreateFileDto) {
    await this.ensureEditor(projectId, userId);
    const name = dto.name.trim();
    if (!name) throw new ConflictException('File name is required');
    const path = normalizePath(dto.path, name);
    const language = dto.language?.trim() || inferLanguage(name);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    try {
      const file = await this.prisma.file.create({
        data: { projectId, name, path, language },
      });

      // Seed the CRDT document with an empty text so the first sync works
      // even before any editor types anything.
      const doc = new Y.Doc();
      doc.getText('content');
      const update = Y.encodeStateAsUpdate(doc);
      await this.prisma.documentUpdate.create({
        data: {
          fileId: file.id,
          update: Buffer.from(update),
          sizeBytes: update.length,
        },
      });
      return file;
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002'
      ) {
        throw new ConflictException(`File already exists at ${path}`);
      }
      throw err;
    }
  }

  async get(fileId: string, userId: string) {
    const { role, file } = await this.permissions.requireFileRole(fileId, userId);
    const full = await this.prisma.file.findUnique({ where: { id: file.id } });
    if (!full) throw new NotFoundException('File not found');
    return { ...full, role };
  }

  async rename(fileId: string, userId: string, dto: UpdateFileDto) {
    const { role, file } = await this.permissions.requireFileRole(fileId, userId);
    if (role === 'viewer') {
      throw new ForbiddenException('Viewers cannot rename files');
    }
    const full = await this.prisma.file.findUnique({ where: { id: file.id } });
    if (!full) throw new NotFoundException('File not found');

    const nextName = (dto.name ?? full.name).trim();
    const dirPart = dto.path
      ? dto.path.trim().replace(/^\/+/, '').replace(/\/+$/, '')
      : full.path.includes('/')
        ? full.path.slice(0, full.path.lastIndexOf('/'))
        : '';
    const nextPath = dirPart ? `${dirPart}/${nextName}` : nextName;
    const language = dto.name ? inferLanguage(nextName) : full.language;

    try {
      return await this.prisma.file.update({
        where: { id: file.id },
        data: { name: nextName, path: nextPath, language },
      });
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002'
      ) {
        throw new ConflictException(`File already exists at ${nextPath}`);
      }
      throw err;
    }
  }

  async remove(fileId: string, userId: string) {
    const { role, file } = await this.permissions.requireFileRole(fileId, userId);
    if (role === 'viewer') {
      throw new ForbiddenException('Viewers cannot delete files');
    }
    await this.prisma.file.delete({ where: { id: file.id } });
    return { ok: true };
  }

  /**
   * Read the current plain text of a file by reconstructing the persisted Yjs
   * state (latest snapshot in S3 + subsequent updates in Postgres).
   * Live editing uses the WebSocket Yjs sync, not this endpoint.
   */
  async readContent(
    fileId: string,
    userId: string,
  ): Promise<{ content: string; language: string }> {
    const { file } = await this.permissions.requireFileRole(fileId, userId);
    const doc = await this.loadDocument(file.id);
    const meta = await this.prisma.file.findUniqueOrThrow({
      where: { id: file.id },
      select: { language: true },
    });
    return { content: doc.getText('content').toString(), language: meta.language };
  }

  /**
   * Reconstruct a Y.Doc from the last snapshot + tail of the update log.
   */
  async loadDocument(fileId: string): Promise<Y.Doc> {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true },
    });
    if (!file) throw new NotFoundException('File not found');

    const snapshot = await this.prisma.fileSnapshot.findFirst({
      where: { fileId },
      orderBy: { version: 'desc' },
    });

    const doc = new Y.Doc();

    if (snapshot) {
      const bytes = await this.storage.getSnapshot(snapshot.s3Key);
      Y.applyUpdate(doc, bytes);
    }

    const rows = await this.prisma.documentUpdate.findMany({
      where: snapshot
        ? { fileId, id: { gt: BigInt(snapshot.lastUpdateId) } }
        : { fileId },
      orderBy: { id: 'asc' },
    });
    for (const row of rows) {
      Y.applyUpdate(doc, row.update as unknown as Uint8Array);
    }
    return doc;
  }
}
