import type { FastifyInstance } from 'fastify';
import { authenticate, authContext } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import { listFlowInclude } from '../domain/flow.ts';
import { TASK_STATUSES, toTaskItem, type TaskItem } from '../domain/orders.ts';
import { ok } from '../http/respond.ts';
import { shanghaiDateKey } from '../lib/time.ts';

/** 单次最多返回的待办数：队列按交期升序，长尾靠订单总览查。 */
const TASK_LIMIT = 60;

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/tasks', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const { role, id: userId, departmentId } = auth.user;

    const orders = await prisma.order.findMany({
      where: { status: { in: TASK_STATUSES[role] } },
      include: listFlowInclude,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      take: TASK_LIMIT,
    });

    const today = shanghaiDateKey();
    const tasks: TaskItem[] = [];
    for (const order of orders) {
      const task = toTaskItem(order, role, userId, departmentId, today);
      if (task) tasks.push(task);
    }

    return ok(reply, tasks, 200, {
      page: 1,
      pageSize: TASK_LIMIT,
      total: tasks.length,
      totalPages: 1,
    });
  });
}