import { prisma } from '../db.ts';
import { Errors, isPrismaError } from '../errors.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { requestHash } from './canonical.ts';

export interface OperationResult<T> {
  status: number;
  data: T;
  resourceId?: string;
}

export interface IdempotentOutcome<T> {
  status: number;
  data: T;
  replayed: boolean;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function normaliseKey(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.trim().length === 0) {
    throw Errors.validation('写操作必须携带 Idempotency-Key 请求头', [
      { path: 'headers.Idempotency-Key', message: '缺少幂等键' },
    ]);
  }
  if (value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw Errors.validation('Idempotency-Key 格式不合法（8-128 位字母、数字或 . _ : -）');
  }
  return value;
}

/**
 * 幂等执行器：
 * 1. 幂等记录与业务写入在同一个事务内，业务失败则记录一起回滚，重试是安全的。
 * 2. 同 key 不同请求体直接拒绝，避免“复用旧结果”掩盖客户端错误。
 * 3. 已完成请求原样返回首次结果，并标记 replayed=true。
 */
export async function runIdempotent<T>(
  options: {
    actorId: string;
    operation: string;
    key: string | string[] | undefined;
    body: unknown;
    handler: (tx: Prisma.TransactionClient) => Promise<OperationResult<T>>;
  },
): Promise<IdempotentOutcome<T>> {
  const key = normaliseKey(options.key);
  const hash = requestHash(options.body);

  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const record = await tx.idempotencyRequest.create({
          data: {
            actorId: options.actorId,
            operation: options.operation,
            key,
            requestHash: hash,
            status: 'IN_PROGRESS',
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
          },
        });

        const result = await options.handler(tx);

        await tx.idempotencyRequest.update({
          where: { id: record.id },
          data: {
            status: 'COMPLETED',
            responseJson: result.data as Prisma.InputJsonValue,
            resourceId: result.resourceId ?? null,
          },
        });

        return { status: result.status, data: result.data, replayed: false };
      },
      { timeout: 15_000 },
    );

    return outcome;
  } catch (error) {
    if (!isPrismaError(error, 'P2002')) throw error;

    const existing = await prisma.idempotencyRequest.findUnique({
      where: {
        actorId_operation_key: {
          actorId: options.actorId,
          operation: options.operation,
          key,
        },
      },
    });

    // 不是幂等键冲突，而是业务写入里的其他唯一约束冲突：原样抛出。
    if (!existing) throw error;

    if (existing.requestHash !== hash) {
      throw Errors.conflict(
        'IDEMPOTENCY_KEY_REUSED',
        '该 Idempotency-Key 已用于不同的请求内容，请换一个新的键',
      );
    }

    if (existing.status === 'COMPLETED') {
      return {
        status: 200,
        data: existing.responseJson as T,
        replayed: true,
      };
    }

    throw Errors.conflict('REQUEST_IN_PROGRESS', '相同请求正在处理中，请稍后重试');
  }
}

export function replayHeaders(replayed: boolean): Record<string, string> {
  return replayed ? { 'Idempotent-Replayed': 'true' } : {};
}

export const idempotencyTtlHours = Math.round(IDEMPOTENCY_TTL_MS / 3_600_000);