import type { Prisma } from '../generated/prisma/client.ts';
import type { AuditResult } from '../generated/prisma/enums.ts';

type Db = Prisma.TransactionClient;

export interface AuditInput {
  requestId: string;
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  result?: AuditResult;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
}

/**
 * 审计日志必须与业务写入在同一事务里，保证“有业务记录就一定有审计”。
 * 只读操作不写审计。
 */
export async function writeAudit(tx: Db, input: AuditInput): Promise<void> {
  await tx.auditLog.create({
    data: {
      requestId: input.requestId,
      actorId: input.actorId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      result: input.result ?? 'SUCCESS',
      beforeJson: input.before,
      afterJson: input.after,
    },
  });
}