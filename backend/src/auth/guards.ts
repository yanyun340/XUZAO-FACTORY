import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { config } from '../config.ts';
import { Errors } from '../errors.ts';
import { findSessionContext, type SessionUser } from './session.ts';
import type { Role } from '../generated/prisma/enums.ts';

export interface AuthContext {
  user: SessionUser;
  sessionId: string;
  expiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

async function loadAuth(request: FastifyRequest): Promise<AuthContext> {
  const token = request.cookies[config.sessionCookieName];
  if (!token) {
    throw Errors.unauthenticated('请先登录', 'NOT_LOGGED_IN');
  }

  const context = await findSessionContext(token);
  if (!context) {
    throw Errors.unauthenticated('登录已失效，请重新登录', 'SESSION_EXPIRED');
  }

  return {
    user: context.user,
    sessionId: context.session.id,
    expiresAt: context.session.expiresAt,
  };
}

export const authenticate: preHandlerAsyncHookHandler = async (request) => {
  request.auth = await loadAuth(request);
};

export function requireRoles(...roles: Role[]): preHandlerAsyncHookHandler {
  return async (request) => {
    const auth = request.auth ?? (await loadAuth(request));
    request.auth = auth;
    if (!roles.includes(auth.user.role)) {
      throw Errors.forbidden('当前角色不能执行该操作');
    }
  };
}

export const requireAdmin = requireRoles('ADMIN');

/** 给路由用的断言版本：经过 authenticate 后一定非空。 */
export function authContext(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw Errors.unauthenticated('请先登录', 'NOT_LOGGED_IN');
  }
  return request.auth;
}