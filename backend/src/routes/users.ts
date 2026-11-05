import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth/password.ts';
import { authenticate, authContext, requireAdmin } from '../auth/guards.ts';
import { revokeAllSessions } from '../auth/session.ts';
import { prisma } from '../db.ts';
import { Role } from '../generated/prisma/enums.ts';
import { Errors } from '../errors.ts';
import { ok } from '../http/respond.ts';
import { writeAudit } from '../lib/audit.ts';

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().max(50).optional(),
  role: z.nativeEnum(Role).optional(),
  active: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
});

const idParam = z.object({ id: z.string().uuid('用户 ID 不合法') });

const createSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, '用户名至少 3 个字符')
    .max(30)
    .regex(/^[A-Za-z0-9_.-]+$/, '用户名只能包含字母、数字、下划线、点或短横线'),
  password: z.string().min(8, '密码至少 8 位').max(200),
  displayName: z.string().trim().min(1, '请填写显示名称').max(50),
  role: z.nativeEnum(Role),
  departmentId: z.string().uuid().nullable().optional(),
});

const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(50).optional(),
    role: z.nativeEnum(Role).optional(),
    departmentId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有需要修改的字段' });

const passwordSchema = z.object({ password: z.string().min(8, '密码至少 8 位').max(200) });

/** 管理员账号管理：停用、改角色、重置密码，以及主动吊销会话。 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/users', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const query = pageSchema.parse(request.query);
    const where = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.active === undefined ? {} : { active: query.active }),
      ...(query.keyword
        ? {
            OR: [
              { username: { contains: query.keyword, mode: 'insensitive' as const } },
              { displayName: { contains: query.keyword, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [total, rows] = await prisma.$transaction([
      prisma.adminUser.count({ where }),
      prisma.adminUser.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          department: { select: { id: true, code: true, name: true, category: true } },
          _count: { select: { sessions: { where: { revokedAt: null } } } },
        },
      }),
    ]);

    return ok(
      reply,
      rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        role: row.role,
        active: row.active,
        department: row.department,
        activeSessions: row._count.sessions,
        createdAt: row.createdAt.toISOString(),
      })),
      200,
      {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    );
  });

  app.post('/api/v1/users', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const body = createSchema.parse(request.body);

    if (body.departmentId) {
      const department = await prisma.department.findUnique({ where: { id: body.departmentId } });
      if (!department) throw Errors.notFound('部门不存在', 'DEPARTMENT_NOT_FOUND');
    }

    const passwordHash = await hashPassword(body.password);

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.adminUser.create({
        data: {
          username: body.username,
          passwordHash,
          displayName: body.displayName,
          role: body.role,
          departmentId: body.departmentId ?? null,
        },
      });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'user.create',
        resourceType: 'user',
        resourceId: user.id,
        after: { username: user.username, displayName: user.displayName, role: user.role },
      });
      return user;
    });

    return ok(
      reply,
      {
        id: created.id,
        username: created.username,
        displayName: created.displayName,
        role: created.role,
        active: created.active,
      },
      201,
    );
  });

  app.patch(
    '/api/v1/users/:id',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = idParam.parse(request.params);
      const body = updateSchema.parse(request.body);

      const target = await prisma.adminUser.findUnique({ where: { id } });
      if (!target) throw Errors.notFound('用户不存在', 'USER_NOT_FOUND');

      const isSelf = target.id === auth.user.id;
      if (isSelf && body.active === false) {
        throw Errors.badRequest('不能停用当前登录账号', 'CANNOT_DISABLE_SELF');
      }
      if (isSelf && body.role && body.role !== target.role) {
        throw Errors.badRequest('不能修改自己的角色', 'CANNOT_CHANGE_OWN_ROLE');
      }

      if (body.departmentId) {
        const department = await prisma.department.findUnique({ where: { id: body.departmentId } });
        if (!department) throw Errors.notFound('部门不存在', 'DEPARTMENT_NOT_FOUND');
      }

      const roleChanged = body.role !== undefined && body.role !== target.role;
      const revoked = body.active === false || roleChanged;

      const updated = await prisma.$transaction(async (tx) => {
        const user = await tx.adminUser.update({
          where: { id },
          data: {
            ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
            ...(body.active !== undefined ? { active: body.active } : {}),
            // 改角色 / 停用时让已签发会话立即失效，不需要等过期
            ...(revoked ? { sessionVersion: { increment: 1 } } : {}),
          },
        });
        if (revoked) {
          await tx.session.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'user.update',
          resourceType: 'user',
          resourceId: id,
          before: {
            displayName: target.displayName,
            role: target.role,
            active: target.active,
            departmentId: target.departmentId,
          },
          after: {
            displayName: user.displayName,
            role: user.role,
            active: user.active,
            departmentId: user.departmentId,
            sessionsRevoked: revoked,
          },
        });
        return user;
      });

      return ok(reply, {
        id: updated.id,
        username: updated.username,
        displayName: updated.displayName,
        role: updated.role,
        active: updated.active,
        departmentId: updated.departmentId,
        sessionsRevoked: revoked,
      });
    },
  );

  app.post(
    '/api/v1/users/:id/password',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = idParam.parse(request.params);
      const body = passwordSchema.parse(request.body);

      const target = await prisma.adminUser.findUnique({ where: { id } });
      if (!target) throw Errors.notFound('用户不存在', 'USER_NOT_FOUND');

      const passwordHash = await hashPassword(body.password);

      await prisma.$transaction(async (tx) => {
        await tx.adminUser.update({
          where: { id },
          data: { passwordHash, sessionVersion: { increment: 1 } },
        });
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'user.password.reset',
          resourceType: 'user',
          resourceId: id,
          after: { username: target.username, sessionsRevoked: true },
        });
      });

      return ok(reply, { reset: true, sessionsRevoked: true });
    },
  );

  app.post(
    '/api/v1/users/:id/revoke-sessions',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = idParam.parse(request.params);

      const target = await prisma.adminUser.findUnique({ where: { id } });
      if (!target) throw Errors.notFound('用户不存在', 'USER_NOT_FOUND');

      const activeSessions = await prisma.session.count({ where: { userId: id, revokedAt: null } });
      await revokeAllSessions(id);

      await prisma.auditLog.create({
        data: {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'user.sessions.revoke',
          resourceType: 'user',
          resourceId: id,
          result: 'SUCCESS',
          afterJson: { revokedSessions: activeSessions },
        },
      });

      return ok(reply, { revoked: activeSessions });
    },
  );
}