import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import { OrderStatus } from '../generated/prisma/enums.ts';
import { shanghaiDateKey } from '../lib/time.ts';
import { STATUS_LABELS } from '../domain/orders.ts';

const exportQuery = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  keyword: z.string().trim().max(100).optional(),
  customerId: z.string().uuid().optional(),
});

const MAX_ROWS = 10_000;

const HEADER = [
  '订单号',
  '客户',
  '联系人',
  '交期',
  '状态',
  '产品明细',
  '总数量',
  '订单金额',
  '创建时间',
  '完成时间',
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

      const workbook = new ExcelJS.Workbook();
      workbook.creator = '序造 XuZao';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet('订单列表', {
        views: [{ state: 'frozen', ySplit: 1 }],
      });

      sheet.columns = [
        { width: 20 },
        { width: 22 },
        { width: 14 },
        { width: 12 },
        { width: 10 },
        { width: 40 },
        { width: 10 },
        { width: 14 },
        { width: 18 },
        { width: 18 },
      ];

      const header = sheet.addRow(HEADER);
      header.font = { bold: true };
      header.alignment = { vertical: 'middle' };
      header.height = 22;

      for (const order of orders) {
        const totalQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
        const totalAmount = order.items.reduce(
          (sum, item) => sum + Number(item.unitPrice) * item.quantity,
          0,
        );

        const row = sheet.addRow([
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
        ]);

        row.getCell(8).numFmt = '#,##0.00';
      }

      if (orders.length > 0) {
        sheet.autoFilter = { from: 'A1', to: `J${orders.length + 1}` };
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const fileName = `xuzao-orders-${shanghaiDateKey()}.xlsx`;

      reply.header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      reply.header(
        'Content-Disposition',
        `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      return reply.send(Buffer.from(buffer));
    },
  );
}