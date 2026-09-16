import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthedRequest } from './jwt-auth.guard';
import { AuthUser } from './jwt-user';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) {
      throw new Error('CurrentUser used without JwtAuthGuard');
    }
    return req.user;
  },
);
