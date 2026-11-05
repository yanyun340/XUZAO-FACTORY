/**
 * 统一业务错误。
 * code 是给前端判断用的稳定机器码，message 是可直接展示的中文说明。
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  validation(message = '请求参数不合法', details?: unknown) {
    return new AppError(400, 'VALIDATION_ERROR', message, details);
  },
  badRequest(message: string, code = 'BAD_REQUEST', details?: unknown) {
    return new AppError(400, code, message, details);
  },
  unauthenticated(message = '请先登录', code = 'UNAUTHENTICATED') {
    return new AppError(401, code, message);
  },
  forbidden(message = '没有权限执行该操作') {
    return new AppError(403, 'FORBIDDEN', message);
  },
  notFound(message = '资源不存在', code = 'NOT_FOUND') {
    return new AppError(404, code, message);
  },
  conflict(code: string, message: string, details?: unknown) {
    return new AppError(409, code, message, details);
  },
  business(message: string, code = 'BUSINESS_RULE_VIOLATION', details?: unknown) {
    return new AppError(422, code, message, details);
  },
  serviceUnavailable(message = '数据库暂时不可用，请稍后重试') {
    return new AppError(503, 'DATABASE_UNAVAILABLE', message);
  },
  internal(message = '服务器内部错误') {
    return new AppError(500, 'INTERNAL_ERROR', message);
  },
};

export function isPrismaError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

export function prismaErrorTarget(error: unknown): string[] {
  if (
    typeof error === 'object' &&
    error !== null &&
    'meta' in error &&
    typeof (error as { meta?: unknown }).meta === 'object'
  ) {
    const target = (error as { meta?: { target?: unknown } }).meta?.target;
    if (Array.isArray(target)) return target.map(String);
    if (typeof target === 'string') return [target];
  }
  return [];
}