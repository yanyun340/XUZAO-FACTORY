import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.ts';
import { AppError, Errors, isPrismaError, prismaErrorTarget } from './errors.ts';
import { fail } from './http/respond.ts';
import { attachmentRoutes } from './routes/attachments.ts';
import { auditRoutes } from './routes/audit.ts';
import { authRoutes } from './routes/auth.ts';
import { baseDataRoutes } from './routes/base-data.ts';
import { collabRoutes } from './routes/collab.ts';
import { exportRoutes } from './routes/export.ts';
import { flowRoutes } from './routes/flow.ts';
import { healthRoutes } from './routes/health.ts';
import { importRoutes } from './routes/imports.ts';
import { inventoryRoutes } from './routes/inventory.ts';
import { orderRoutes } from './routes/orders.ts';
import { taskRoutes } from './routes/tasks.ts';
import { userRoutes } from './routes/users.ts';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 上传来源校验：APP_ORIGIN 支持逗号分隔多个地址。
 * 开发环境额外放行局域网 IP，便于手机连同一 Wi-Fi 直接调试。
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const allowed = config.appOrigin.split(',').map((item) => item.trim());
  if (allowed.includes(origin)) return true;
  if (config.isProduction) return false;
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === 'http:' && /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

/** 生产模式下由后端托管 Vite 构建产物，单端口即可部署。 */
const FRONTEND_DIST = fileURLToPath(new URL('../../frontend/dist', import.meta.url));

const FIELD_LABELS: Record<string, string> = {
  username: '用户名',
  code: '编码',
  orderNo: '订单号',
  name: '名称',
};

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: config.isTest ? 'silent' : config.logLevel },
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    disableRequestLogging: true,
  });

  app.register(cookie);

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  /**
   * CSRF 基线：状态变更请求必须是 JSON。
   * 配合 HttpOnly + SameSite=Lax 的会话 Cookie，跨站表单无法伪造写操作。
   */
  app.addHook('preValidation', async (request) => {
    if (!WRITE_METHODS.has(request.method)) return;
    if (request.body === undefined) return;
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase();

    // 附件上传只能用 multipart，额外要求 Origin 与站点一致
    if (contentType.includes('multipart/form-data')) {
      const origin = request.headers.origin;
      if (!isAllowedOrigin(origin)) {
        throw Errors.forbidden('上传请求来源不合法');
      }
      return;
    }

    if (!contentType.includes('application/json')) {
      throw Errors.validation('写操作必须使用 application/json 请求体');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return fail(
        reply,
        400,
        'VALIDATION_ERROR',
        '请求参数不合法',
        error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, requestId: request.id }, 'request.failed');
      } else {
        request.log.warn(
          { code: error.code, requestId: request.id, statusCode: error.statusCode },
          'request.rejected',
        );
      }
      return fail(reply, error.statusCode, error.code, error.message, error.details);
    }

    if (isPrismaError(error, 'P2002')) {
      const fields = prismaErrorTarget(error);
      const labels = fields.map((field) => FIELD_LABELS[field] ?? field).join('、');
      return fail(
        reply,
        409,
        'DUPLICATE_VALUE',
        labels ? `${labels}已存在，请更换` : '数据重复，请检查唯一字段',
        { fields },
      );
    }

    if (isPrismaError(error, 'P2003')) {
      return fail(reply, 422, 'REFERENCE_NOT_FOUND', '关联的数据不存在');
    }

    if (isPrismaError(error, 'P2025')) {
      return fail(reply, 404, 'NOT_FOUND', '资源不存在或已被删除');
    }

    if (
      isPrismaError(error, 'P1001') ||
      isPrismaError(error, 'P1002') ||
      isPrismaError(error, 'P1008') ||
      isPrismaError(error, 'P1017')
    ) {
      return fail(reply, 503, 'DATABASE_UNAVAILABLE', '数据库暂时不可用，请稍后重试');
    }

    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode === 413) {
      return fail(reply, 413, 'PAYLOAD_TOO_LARGE', '请求体超过 1MB 限制');
    }

    request.log.error({ err: error, requestId: request.id }, 'request.unhandled');
    return fail(reply, 500, 'INTERNAL_ERROR', '服务器内部错误');
  });

  const serveFrontend = config.isProduction && existsSync(FRONTEND_DIST);

  app.setNotFoundHandler((request, reply) => {
    if (
      serveFrontend &&
      request.method === 'GET' &&
      !request.url.startsWith('/api/')
    ) {
      return reply.sendFile('index.html');
    }
    return fail(reply, 404, 'ROUTE_NOT_FOUND', `接口不存在：${request.method} ${request.url}`);
  });

  if (serveFrontend) {
    app.register(fastifyStatic, {
      root: FRONTEND_DIST,
      wildcard: false,
      index: ['index.html'],
    });
  }

  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(exportRoutes);
  app.register(orderRoutes);
  app.register(taskRoutes);
  app.register(flowRoutes);
  app.register(baseDataRoutes);
  app.register(collabRoutes);
  app.register(inventoryRoutes);
  app.register(importRoutes);
  app.register(attachmentRoutes);
  app.register(auditRoutes);
  app.register(userRoutes);

  return app;
}