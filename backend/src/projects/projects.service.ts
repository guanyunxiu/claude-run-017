import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { PermissionService } from './permission.service';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  async create(userId: string, dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: {
        name: dto.name.trim(),
        ownerId: userId,
      },
    });
  }

  async listForUser(userId: string) {
    const owned = await this.prisma.project.findMany({
      where: { ownerId: userId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, color: true } } },
        },
        owner: { select: { id: true, name: true, email: true, color: true } },
        _count: { select: { files: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const memberProjects = await this.prisma.project.findMany({
      where: {
        members: { some: { userId } },
        owner: { isNot: { id: userId } },
      },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, color: true } } },
        },
        owner: { select: { id: true, name: true, email: true, color: true } },
        _count: { select: { files: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return [...owned, ...memberProjects].map((p) => this.serialize(p, userId));
  }

  async get(projectId: string, userId: string) {
    await this.permissions.requireProjectRole(projectId, userId);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, color: true } } },
        },
        owner: { select: { id: true, name: true, email: true, color: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    return this.serialize(project, userId);
  }

  async rename(projectId: string, userId: string, name: string) {
    await this.permissions.requireAtLeast(projectId, userId, 'editor');
    return this.prisma.project.update({
      where: { id: projectId },
      data: { name: name.trim() },
    });
  }

  async remove(projectId: string, userId: string) {
    await this.permissions.requireAtLeast(projectId, userId, 'owner');
    await this.prisma.project.delete({ where: { id: projectId } });
    return { ok: true };
  }

  async listMembers(projectId: string, userId: string) {
    await this.permissions.requireProjectRole(projectId, userId);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        owner: { select: { id: true, name: true, email: true, color: true } },
        members: {
          include: { user: { select: { id: true, name: true, email: true, color: true } } },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const list = [
      { ...project.owner, role: 'owner' as const, joinedAt: project.createdAt },
      ...project.members
        .filter((m) => m.userId !== project.ownerId)
        .map((m) => ({
          ...m.user,
          role: m.role,
          joinedAt: m.createdAt,
        })),
    ];
    return list;
  }

  async addMember(projectId: string, userId: string, dto: AddMemberDto) {
    await this.permissions.requireAtLeast(projectId, userId, 'owner');
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new NotFoundException('User with that email not found');
    if (user.id === userId) {
      throw new ForbiddenException('You are already the owner');
    }
    try {
      const member = await this.prisma.projectMember.create({
        data: { projectId, userId: user.id, role: dto.role },
      });
      return member;
    } catch (err: unknown) {
      // Unique constraint violation => already a member
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002'
      ) {
        throw new ForbiddenException('User is already a member');
      }
      throw err;
    }
  }

  async updateMemberRole(
    projectId: string,
    userId: string,
    memberId: string,
    role: 'editor' | 'viewer',
  ) {
    await this.permissions.requireAtLeast(projectId, userId, 'owner');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (memberId === project.ownerId) {
      throw new ForbiddenException("Cannot change the owner's role");
    }
    const updated = await this.prisma.projectMember.updateMany({
      where: { id: memberId, projectId },
      data: { role },
    });
    if (updated.count === 0) throw new NotFoundException('Member not found');
    return { ok: true };
  }

  async removeMember(projectId: string, userId: string, memberId: string) {
    await this.permissions.requireAtLeast(projectId, userId, 'owner');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (memberId === project.ownerId) {
      throw new ForbiddenException('Cannot remove the owner');
    }
    const removed = await this.prisma.projectMember.deleteMany({
      where: { id: memberId, projectId },
    });
    if (removed.count === 0) throw new NotFoundException('Member not found');
    return { ok: true };
  }

  private serialize(
    p: {
      id: string;
      name: string;
      ownerId: string;
      createdAt: Date;
      updatedAt: Date;
      owner: { id: string; name: string; email: string; color: string };
      members: Array<{
        id: string;
        role: string;
        userId: string;
        user: { id: string; name: string; email: string; color: string };
      }>;
      _count?: { files: number };
    },
    currentUserId: string,
  ) {
    const myMembership = p.members.find((m) => m.userId === currentUserId);
    const role =
      p.ownerId === currentUserId ? 'owner' : (myMembership?.role ?? 'viewer');
    return {
      id: p.id,
      name: p.name,
      ownerId: p.ownerId,
      owner: p.owner,
      role,
      fileCount: p._count?.files,
      members: p.members.map((m) => ({
        id: m.id,
        role: m.role,
        user: m.user,
      })),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }
}
