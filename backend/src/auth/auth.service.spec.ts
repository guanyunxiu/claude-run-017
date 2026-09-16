import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const users: Array<{
    id: string;
    email: string;
    name: string;
    passwordHash: string;
    color: string;
  }> = [];

  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) return users.find((u) => u.email === where.email) ?? null;
        if (where.id) return users.find((u) => u.id === where.id) ?? null;
        return null;
      }),
      create: jest.fn(async ({ data }: { data: (typeof users)[number] }) => {
        const row = { ...data, id: `u-${users.length + 1}` };
        users.push(row);
        return row;
      }),
    },
  };

  const jwt = {
    sign: jest.fn(() => 'signed-token'),
    verify: jest.fn(),
  } as unknown as JwtService;

  let service: AuthService;

  beforeEach(() => {
    users.length = 0;
    jest.clearAllMocks();
    service = new AuthService(prisma as never, jwt);
  });

  it('registers a new user with a hashed password and color', async () => {
    const result = await service.register({
      email: 'Alice@Example.com',
      name: 'Alice',
      password: 'secret123',
    });
    expect(result.token).toBe('signed-token');
    expect(result.user.email).toBe('alice@example.com');
    expect(result.user.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(users[0].passwordHash).not.toBe('secret123');
  });

  it('rejects duplicate registration', async () => {
    await service.register({
      email: 'a@x.com',
      name: 'A',
      password: 'secret123',
    });
    await expect(
      service.register({ email: 'a@x.com', name: 'A2', password: 'secret123' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('logs in with the correct password and rejects wrong ones', async () => {
    await service.register({
      email: 'a@x.com',
      name: 'A',
      password: 'secret123',
    });
    const ok = await service.login({ email: 'a@x.com', password: 'secret123' });
    expect(ok.token).toBe('signed-token');

    await expect(
      service.login({ email: 'a@x.com', password: 'wrong' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.login({ email: 'nobody@x.com', password: 'secret123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns the current user profile by id', async () => {
    const created = await service.register({
      email: 'a@x.com',
      name: 'A',
      password: 'secret123',
    });
    const me = await service.getById(created.user.id);
    expect(me.email).toBe('a@x.com');
  });
});
