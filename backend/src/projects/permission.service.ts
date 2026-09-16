import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ProjectRole, ROLE_LEVEL } from './roles';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the role of userId in projectId or null if no access.
   */
  async getProjectRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });
    if (!project) {
      return null;
    }
    if (project.ownerId === userId) {
      return 'owner';
    }
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    return member ? (member.role as ProjectRole) : null;
  }

  /**
   * Resolves role and throws 404 if the project is missing, 403 if no access.
   */
  async requireProjectRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole> {
    const role = await this.getProjectRole(projectId, userId);
    if (!role) {
      // Distinguish missing project from forbidden where cheaply possible.
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      });
      throw project
        ? new ForbiddenException('You do not have access to this project')
        : new NotFoundException('Project not found');
    }
    return role;
  }

  async requireAtLeast(
    projectId: string,
    userId: string,
    minimum: ProjectRole,
  ): Promise<ProjectRole> {
    const role = await this.requireProjectRole(projectId, userId);
    if (ROLE_LEVEL[role] < ROLE_LEVEL[minimum]) {
      throw new ForbiddenException(
        `This action requires ${minimum} permission`,
      );
    }
    return role;
  }

  /**
   * Role of a user for the project containing a file.
   */
  async getFileRole(
    fileId: string,
    userId: string,
  ): Promise<{ role: ProjectRole; file: { id: string; projectId: string } } | null> {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, projectId: true },
    });
    if (!file) {
      return null;
    }
    const role = await this.getProjectRole(file.projectId, userId);
    return role ? { role, file } : null;
  }

  async requireFileRole(
    fileId: string,
    userId: string,
  ): Promise<{ role: ProjectRole; file: { id: string; projectId: string } }> {
    const result = await this.getFileRole(fileId, userId);
    if (!result) {
      throw new NotFoundException('File not found or access denied');
    }
    return result;
  }
}
