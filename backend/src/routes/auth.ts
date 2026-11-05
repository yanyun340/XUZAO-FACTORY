import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext } from '../auth/guards.ts';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../auth/password.ts';
import { createSession, findSessionContext, revokeSession } from '../auth/session.ts';
import { config } from '../config.ts';
import { prisma } from '../db.ts';
import { toUserDto } from '../domain/users.ts';
import { Errors } from '../errors.ts';
import { ok } from '../http/respond.ts';

const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名').max(50),
  password: z.string().min(1, '请输入密码').max(200),
});

function cookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    path: '/',
    maxAge: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await prisma.adminUser.findUnique({
      where: { username: body.username },
      include: { department: true },
    });

    // 用户不存在也执行一次同强度哈希，减少用户名枚举的时序差异。
    const passwordOk = await verifyPassword(
      body.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordOk || !user.active) {
      await prisma.auditLog.create({
        data: {
          requestId: request.id,
          actorId: user?.id ?? null,
          action: 'auth.login',
          resourceType: 'auth',
          resourceId: user?.id ?? null,
          result: 'FAILURE',
          afterJson: { username: body.username },
        },
      });

      // 统一文案，不区分“用户不存在 / 密码错误 / 已停用”。
      throw Errors.unauthenticated('用户名或密码不正确', 'AUTH_INVALID_CREDENTIALS');
    }

    const { token, expiresAt } = await createSession(user.id);
    reply.setCookie(config.sessionCookieName, token, cookieOptions(expiresAt));

    await prisma.auditLog.create({
      data: {
        requestId: request.id,
        actorId: user.id,
        action: 'auth.login',
        resourceType: 'auth',
        resourceId: user.id,
        result: 'SUCCESS',
        afterJson: { username: user.username, role: user.role },
      },
    });

    request.log.info({ userId: user.id }, 'auth.login');

    return ok(reply, {
      user: toUserDto(user),
      expiresAt: expiresAt.toISOString(),
    });
  });

  app.get('/api/v1/auth/me', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    return ok(reply, {
      user: toUserDto(auth.user),
      expiresAt: auth.expiresAt.toISOString(),
    });
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[config.sessionCookieName];

    if (token) {
      const context = await findSessionContext(token);
      if (context) {
        await revokeSession(context.session.id);
        await prisma.auditLog.create({
          data: {
            requestId: request.id,
            actorId: context.user.id,
            action: 'auth.logout',
            resourceType: 'auth',
            resourceId: context.user.id,
            result: 'SUCCESS',
          },
        });
      }
    }

    reply.clearCookie(config.sessionCookieName, { path: '/' });
    return ok(reply, { loggedOut: true });
  });
}