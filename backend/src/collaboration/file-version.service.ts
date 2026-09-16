import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as Y from 'yjs';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { PermissionService } from '../projects/permission.service';
import { RoomManager } from './room-manager';

export interface FileVersionSummary {
  version: number;
  createdAt: Date;
  sizeBytes: number;
}

export interface FileVersionPreview {
  version: number;
  createdAt: Date;
  content: string;
  language: string;
}

@Injectable()
export class FileVersionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly permissions: PermissionService,
    private readonly rooms: RoomManager,
  ) {}

  /** List retained snapshots for a file (newest first). Requires read access. */
  async listVersions(fileId: string, userId: string): Promise<{
    fileId: string;
    versions: FileVersionSummary[];
  }> {
    await this.permissions.requireFileRole(fileId, userId);
    const rows = await this.prisma.fileSnapshot.findMany({
      where: { fileId },
      orderBy: { version: 'desc' },
      select: { version: true, createdAt: true, sizeBytes: true },
    });
    return {
      fileId,
      versions: rows.map((r) => ({
        version: r.version,
        createdAt: r.createdAt,
        sizeBytes: r.sizeBytes,
      })),
    };
  }

  /** Read-only preview of a single version's text. Requires read access. */
  async previewVersion(
    fileId: string,
    version: number,
    userId: string,
  ): Promise<FileVersionPreview> {
    await this.permissions.requireFileRole(fileId, userId);
    const [snapshot, file] = await Promise.all([
      this.prisma.fileSnapshot.findFirst({
        where: { fileId, version },
      }),
      this.prisma.file.findUnique({
        where: { id: fileId },
        select: { language: true },
      }),
    ]);
    if (!snapshot) {
      throw new NotFoundException(`Version ${version} not found`);
    }
    if (!file) throw new NotFoundException('File not found');

    const bytes = await this.storage.getSnapshot(snapshot.s3Key);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes, this.previewOrigin());
    const content = doc.getText('content').toString();
    doc.destroy();

    return {
      version: snapshot.version,
      createdAt: snapshot.createdAt,
      content,
      language: file.language,
    };
  }

  /**
   * Restore a file to a historical snapshot. Only the project owner may do
   * this. Coordination across backend instances is handled by RoomManager
   * (exclusive restore lock + barrier + bus commit).
   */
  async restoreVersion(
    fileId: string,
    version: number,
    userId: string,
  ): Promise<{ fileId: string; version: number }> {
    // Owner-only gate. requireProjectRole resolves the file -> project chain.
    const access = await this.permissions.getFileRole(fileId, userId);
    if (!access) throw new NotFoundException('File not found');
    const role = await this.permissions.getProjectRole(
      access.file.projectId,
      userId,
    );
    if (role !== 'owner') {
      throw new ForbiddenException('Only the project owner can restore versions');
    }

    // Validate the target exists before opening the restore lock/barrier.
    const snapshot = await this.prisma.fileSnapshot.findFirst({
      where: { fileId, version },
    });
    if (!snapshot) {
      throw new NotFoundException(`Version ${version} not found`);
    }

    const result = await this.rooms.restoreFileVersion(fileId, version);
    return { fileId, version: result.version };
  }

  private previewOrigin(): symbol {
    return Symbol('version-preview');
  }
}
