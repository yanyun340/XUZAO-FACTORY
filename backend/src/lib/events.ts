import type { Prisma } from '../generated/prisma/client.ts';

type Tx = Prisma.TransactionClient;

export interface RecordEventInput {
  orderId: string;
  type: string;
  actorId: string;
  payload?: Prisma.InputJsonValue;
  /** 管理员通知文案；不传则只写时间线，不通知。 */
  notify?: { title: string; body: string };
}

/**
 * 写时间线事件，并在需要时给全部有效管理员生成持久通知。
 * 通知与业务写入在同一事务内，dedupeKey 绑定事件 ID，重放不会重复创建。
 */
export async function recordEvent(tx: Tx, input: RecordEventInput): Promise<void> {
  const event = await tx.timelineEvent.create({
    data: {
      orderId: input.orderId,
      type: input.type,
      actorId: input.actorId,
      payload: input.payload,
    },
  });

  if (!input.notify) return;

  const admins = await tx.adminUser.findMany({
    where: { role: 'ADMIN', active: true },
    select: { id: true },
  });

  for (const admin of admins) {
    await tx.notification.create({
      data: {
        eventType: input.type,
        title: input.notify.title,
        body: input.notify.body,
        recipientId: admin.id,
        orderId: input.orderId,
        dedupeKey: `${input.type}:${event.id}:${admin.id}`,
      },
    });
  }
}