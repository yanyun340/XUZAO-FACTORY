import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import { OrderStatus } from '../generated/prisma/enums.ts';
import { buildWorkbook, sendXlsx, type XlsxColumn } from '../lib/export-workbook.ts';
import { shanghaiDateKey } from '../lib/time.ts';
import { STATUS_LABELS } from '../domain/orders.ts';

const exportQuery = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  keyword: z.string().trim().max(100).optional(),
  customerId: z.string().uuid().optional(),
});

const MAX_ROWS = 10_000;

const COLUMNS: XlsxColumn[] = [
  { header: '订单号', width: 20 },
  { header: '客户', width: 22 },
  { header: '联系人', width: 14 },
  { header: '交期', width: 12 },
  { header: '状态', width: 10 },
  { header: '产品明细', width: 40 },
  { header: '总数量', width: 10 },
  { header: '订单金额', width: 14, numFmt: '#,##0.00' },
  { header: '创建时间', width: 18 },
  { header: '完成时间', width: 18 },
];

function dateKey(date: Date): string {
  // 交期存的是 DATE 类型，直接按 UTC 日期输出，避免时区把日期推后一天
  return date.toISOString().slice(0, 10);
}

function timestamp(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/orders/export.xlsx',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const query = exportQuery.parse(request.query);

      const where = {
        ...(query.status ? { status: query.status } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.keyword
          ? {
              OR: [
                { orderNo: { contains: query.keyword, mode: 'insensitive' as const } },
                { customerName: { contains: query.keyword, mode: 'insensitive' as const } },
                {
                  items: {
                    some: {
                      productName: { contains: query.keyword, mode: 'insensitive' as const },
                    },
                  },
                },
              ],
            }
          : {}),
      };

      const orders = await prisma.order.findMany({
        where,
        include: { items: { orderBy: { id: 'asc' } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_ROWS,
      });

      const rows = orders.map((order) => {
        const totalQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
        const totalAmount = order.items.reduce(
          (sum, item) => sum + Number(item.unitPrice) * item.quantity,
          0,
        );

        return [
          order.orderNo,
          order.customerName,
          order.customerContact ?? '',
          dateKey(order.dueDate),
          STATUS_LABELS[order.status] ?? order.status,
          order.items.map((item) => `${item.productName} / ${item.spec} × ${item.quantity}`).join('；'),
          totalQuantity,
          totalAmount,
          timestamp(order.createdAt),
          order.completedAt ? timestamp(order.completedAt) : '',
        ];
      });

      const workbook = buildWorkbook({ sheetName: '订单列表', columns: COLUMNS, rows });
      return sendXlsx(reply, workbook, `xuzao-orders-${shanghaiDateKey()}.xlsx`);
    },
  );
}