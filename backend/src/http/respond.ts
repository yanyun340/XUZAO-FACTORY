import type { FastifyReply } from 'fastify';

export type Meta = Record<string, unknown>;

/** 成功响应统一信封：{ data, meta.requestId } */
export function ok<T>(reply: FastifyReply, data: T, statusCode = 200, meta: Meta = {}): FastifyReply {
  return reply.code(statusCode).send({
    data,
    meta: { requestId: reply.request.id, ...meta },
  });
}

/** 失败响应统一信封：{ error: { code, message, details }, meta.requestId } */
export function fail(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): FastifyReply {
  return reply.code(statusCode).send({
    error: { code, message, ...(details === undefined ? {} : { details }) },
    meta: { requestId: reply.request.id },
  });
}