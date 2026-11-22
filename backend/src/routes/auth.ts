import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext } from '../auth/guards.ts';
import {
  normalizeDeviceKey,
  resolveLoginDevice,
  shortDeviceCode,
  toDeviceDto,
} from '../auth/device.ts';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../auth/password.ts';
import { createSession, findSessionContext, revokeSession } from '../auth/session.ts';
import { config } from '../config.ts';
import { prisma } from '../db.ts';
import { toUserDto } from '../domain/users.ts';
import { AppError, Errors } from '../errors.ts';
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
    const deviceKey = normalizeDeviceKey(request.headers['x-device-id']);
    const userAgent = request.headers['user-agent'];

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

    // R01F：受控设备。账号未开启时这里直接放行；开启后只认 ACTIVE 设备。
    const resolution = await prisma.$transaction((tx) =>
      resolveLoginDevice(tx, user, deviceKey, userAgent),
    );

    if (!resolution.allowed) {
      await prisma.$transaction(async (tx) => {
        await tx.auditLog.create({
          data: {
            requestId: request.id,
            actorId: user.id,
            action: 'auth.login',
            resourceType: 'auth',
            resourceId: user.id,
            result: 'FAILURE',
            afterJson: {
              username: user.username,
              reason: 'DEVICE_NOT_ALLOWED',
              deviceCode: resolution.deviceCode,
              deviceLabel: resolution.deviceLabel,
            },
          },
        });

        // 通知启用中的管理员去批准；同设备同账号每天只提醒一次。
        const admins = await tx.adminUser.findMany({
          where: { active: true, role: 'ADMIN' },
          select: { id: true },
        });
        if (admins.length > 0) {
          const businessDate = new Date().toISOString().slice(0, 10);
          await tx.notification.createMany({
            data: admins.map((admin) => ({
              eventType: 'DEVICE_PENDING',
              category: 'EXCEPTION' as const,
              title: `未授权设备尝试登录 · ${user.displayName}`,
              body: `设备 ${resolution.deviceCode}（${resolution.deviceLabel}）等待批准。`,
              recipientId: admin.id,
              dedupeKey: `device-pending:${user.id}:${resolution.deviceCode}:${businessDate}:${admin.id}`,
            })),
            skipDuplicates: true,
          });
        }
      });

      throw new AppError(403, 'DEVICE_NOT_ALLOWED', '该设备未授权，请把设备码报给管理员批准', {
        deviceCode: resolution.deviceCode,
        deviceLabel: resolution.deviceLabel,
      });
    }

    const { token, expiresAt } = await createSession(user.id, resolution.deviceId);
    reply.setCookie(config.sessionCookieName, token, cookieOptions(expiresAt));

    await prisma.auditLog.create({
      data: {
        requestId: request.id,
        actorId: user.id,
        action: 'auth.login',
        resourceType: 'auth',
        resourceId: user.id,
        result: 'SUCCESS',
        afterJson: {
          username: user.username,
          role: user.role,
          deviceId: resolution.deviceId,
          deviceCode: deviceKey ? shortDeviceCode(deviceKey) : null,
        },
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

  // R01F：登录用户查看自己的设备，现场人员可以自己确认哪台是已授权设备。
  app.get('/api/v1/auth/devices', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const rows = await prisma.device.findMany({
      where: { userId: auth.user.id },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return ok(reply, rows.map(toDeviceDto));
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