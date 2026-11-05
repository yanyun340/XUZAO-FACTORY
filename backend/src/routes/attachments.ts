import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext } from '../auth/guards.ts';
import { config } from '../config.ts';
import { prisma } from '../db.ts';
import { Errors } from '../errors.ts';
import { ok } from '../http/respond.ts';
import { writeAudit } from '../lib/audit.ts';

/**
 * 只接受白名单类型，并用服务端生成的存储名落盘。
 * 客户端文件名只作为展示字段，绝不参与路径拼接。
 */
const ALLOWED_TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const orderParam = z.object({ id: z.string().uuid('订单 ID 不合法') });
const attachmentParam = z.object({ id: z.string().uuid('附件 ID 不合法') });

function uploadRoot(): string {
  return path.resolve(process.cwd(), config.uploadDir);
}

function safeDisplayName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || '未命名文件';
}

function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}


export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: MAX_ATTACHMENT_BYTES,
      files: 1,
      fields: 5,
    },
  });

  app.post(
    '/api/v1/orders/:id/attachments',
    { preHandler: authenticate, bodyLimit: MAX_ATTACHMENT_BYTES + 64 * 1024 },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = orderParam.parse(request.params);

      const order = await prisma.order.findUnique({ where: { id }, select: { id: true } });
      if (!order) throw Errors.notFound('订单不存在', 'ORDER_NOT_FOUND');

      const file = await request.file();
      if (!file) {
        throw Errors.badRequest('请选择要上传的文件', 'ATTACHMENT_REQUIRED');
      }

      const extension = ALLOWED_TYPES[file.mimetype];
      if (!extension) {
        throw Errors.badRequest(
          `不支持的文件类型：${file.mimetype}。可用类型：PDF、PNG、JPG、WEBP、TXT、CSV、XLSX、DOCX`,
          'ATTACHMENT_TYPE_NOT_ALLOWED',
        );
      }

      const buffer = await file.toBuffer();
      if (buffer.byteLength === 0) {
        throw Errors.badRequest('文件内容为空', 'ATTACHMENT_EMPTY');
      }
      if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
        throw Errors.badRequest('文件超过 5MB 限制', 'ATTACHMENT_TOO_LARGE');
      }

      const storageKey = `${randomUUID()}${extension}`;
      const target = path.join(uploadRoot(), storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buffer, { flag: 'wx' });

      const created = await prisma.$transaction(async (tx) => {
        const attachment = await tx.attachment.create({
          data: {
            ownerType: 'order',
            ownerId: order.id,
            fileName: safeDisplayName(file.filename),
            storageKey,
            mimeType: file.mimetype,
            size: buffer.byteLength,
            uploadedById: auth.user.id,
          },
        });
        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'attachment.upload',
          resourceType: 'attachment',
          resourceId: attachment.id,
          after: {
            orderId: order.id,
            fileName: attachment.fileName,
            size: attachment.size,
            mimeType: attachment.mimeType,
          },
        });
        return attachment;
      });

      return ok(
        reply,
        {
          id: created.id,
          fileName: created.fileName,
          mimeType: created.mimeType,
          size: created.size,
          createdAt: created.createdAt.toISOString(),
          uploadedByName: null,
        },
        201,
      );
    },
  );

  app.get('/api/v1/orders/:id/attachments', { preHandler: authenticate }, async (request, reply) => {
    const { id } = orderParam.parse(request.params);

    const order = await prisma.order.findUnique({ where: { id }, select: { id: true } });
    if (!order) throw Errors.notFound('订单不存在', 'ORDER_NOT_FOUND');

    const rows = await prisma.attachment.findMany({
      where: { ownerType: 'order', ownerId: order.id, deletedAt: null },
      include: { uploadedBy: { select: { displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return ok(
      reply,
      rows.map((row) => ({
        id: row.id,
        fileName: row.fileName,
        mimeType: row.mimeType,
        size: row.size,
        createdAt: row.createdAt.toISOString(),
        uploadedByName: row.uploadedBy.displayName,
      })),
    );
  });

  app.get('/api/v1/attachments/:id/download', { preHandler: authenticate }, async (request, reply) => {
    const { id } = attachmentParam.parse(request.params);

    const attachment = await prisma.attachment.findUnique({ where: { id } });
    if (!attachment || attachment.deletedAt) {
      throw Errors.notFound('附件不存在', 'ATTACHMENT_NOT_FOUND');
    }

    const filePath = path.join(uploadRoot(), attachment.storageKey);
    reply.header('Content-Type', attachment.mimeType);
    reply.header('Content-Disposition', contentDisposition(attachment.fileName));
    reply.header('Content-Length', String(attachment.size));
    return reply.send(createReadStream(filePath));
  });
}