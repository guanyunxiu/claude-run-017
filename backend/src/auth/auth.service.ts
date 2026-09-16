import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../common/prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthUser, JwtUser } from './jwt-user';
import { colorForUser } from './user-colors';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private toAuthUser(user: {
    id: string;
    email: string;
    name: string;
    color: string;
  }): AuthUser {
    return { id: user.id, email: user.email, name: user.name, color: user.color };
  }

  async register(dto: RegisterDto): Promise<{ token: string; user: AuthUser }> {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name.trim(),
        passwordHash,
        color: colorForUser(email),
      },
    });

    return { token: this.sign(user), user: this.toAuthUser(user) };
  }

  async login(dto: LoginDto): Promise<{ token: string; user: AuthUser }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return { token: this.sign(user), user: this.toAuthUser(user) };
  }

  async getById(id: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    return this.toAuthUser(user);
  }

  sign(user: { id: string; email: string; name: string; color: string }): string {
    const payload: JwtUser = {
      sub: user.id,
      email: user.email,
      name: user.name,
      color: user.color,
    };
    return this.jwt.sign(payload);
  }
}
