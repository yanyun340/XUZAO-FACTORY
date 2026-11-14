import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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

/** R17F：附件可以挂在订单链路的哪些层级。 */
export const ATTACHMENT_OWNER_TYPES = [
  'order',
  'purchase',
  'production',
  'qc',
  'shipment',
] as const;
type OwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];

const orderParam = z.object({ id: z.string().uuid('订单 ID 不合法') });
const attachmentParam = z.object({ id: z.string().uuid('附件 ID 不合法') });
const ownerParam = z.object({
  ownerType: z.enum(ATTACHMENT_OWNER_TYPES),
  ownerId: z.string().uuid('资源 ID 不合法'),
});

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

async function ownerExists(ownerType: OwnerType, ownerId: string): Promise<boolean> {
  switch (ownerType) {
    case 'order':
      return Boolean(await prisma.order.findUnique({ where: { id: ownerId }, select: { id: true } }));
    case 'purchase':
      return Boolean(
        await prisma.purchaseOrder.findUnique({ where: { id: ownerId }, select: { id: true } }),
      );
    case 'production':
      return Boolean(
        await prisma.productionOrder.findUnique({ where: { id: ownerId }, select: { id: true } }),
      );
    case 'qc':
      return Boolean(
        await prisma.qCRecord.findUnique({ where: { id: ownerId }, select: { id: true } }),
      );
    case 'shipment':
      return Boolean(
        await prisma.shipmentRecord.findUnique({ where: { id: ownerId }, select: { id: true } }),
      );
  }
}

async function uploadAttachment(
  request: FastifyRequest,
  reply: FastifyReply,
  ownerType: OwnerType,
  ownerId: string,
) {
  const auth = authContext(request);

  if (!(await ownerExists(ownerType, ownerId))) {
    throw Errors.notFound('附件关联的业务对象不存在', 'OWNER_NOT_FOUND');
  }

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
        ownerType,
        ownerId,
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
        ownerType,
        ownerId,
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
      ownerType: created.ownerType,
      ownerId: created.ownerId,
      fileName: created.fileName,
      mimeType: created.mimeType,
      size: created.size,
      createdAt: created.createdAt.toISOString(),
      uploadedByName: null,
    },
    201,
  );
}

async function listAttachments(
  reply: FastifyReply,
  ownerType: OwnerType,
  ownerId: string,
) {
  if (!(await ownerExists(ownerType, ownerId))) {
    throw Errors.notFound('附件关联的业务对象不存在', 'OWNER_NOT_FOUND');
  }

  const rows = await prisma.attachment.findMany({
    where: { ownerType, ownerId, deletedAt: null },
    include: { uploadedBy: { select: { displayName: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });

  return ok(
    reply,
    rows.map((row) => ({
      id: row.id,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      size: row.size,
      createdAt: row.createdAt.toISOString(),
      uploadedById: row.uploadedById,
      uploadedByName: row.uploadedBy.displayName,
    })),
  );
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: MAX_ATTACHMENT_BYTES,
      files: 1,
      fields: 5,
    },
  });

  // 订单层级的显式路由保留，避免旧前端路径失效。
  app.post(
    '/api/v1/orders/:id/attachments',
    { preHandler: authenticate, bodyLimit: MAX_ATTACHMENT_BYTES + 64 * 1024 },
    async (request, reply) => {
      const { id } = orderParam.parse(request.params);
      return uploadAttachment(request, reply, 'order', id);
    },
  );

  app.get('/api/v1/orders/:id/attachments', { preHandler: authenticate }, async (request, reply) => {
    const { id } = orderParam.parse(request.params);
    return listAttachments(reply, 'order', id);
  });

  // 通用层级：采购单 / 生产任务 / 质检记录 / 发货记录。
  app.post(
    '/api/v1/:ownerType/:ownerId/attachments',
    { preHandler: authenticate, bodyLimit: MAX_ATTACHMENT_BYTES + 64 * 1024 },
    async (request, reply) => {
      const { ownerType, ownerId } = ownerParam.parse(request.params);
      return uploadAttachment(request, reply, ownerType, ownerId);
    },
  );

  app.get(
    '/api/v1/:ownerType/:ownerId/attachments',
    { preHandler: authenticate },
    async (request, reply) => {
      const { ownerType, ownerId } = ownerParam.parse(request.params);
      return listAttachments(reply, ownerType, ownerId);
    },
  );

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

  // R17F：软删除。上传者本人或管理员可删，记录保留、文件延后清理。
  app.delete('/api/v1/attachments/:id', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = attachmentParam.parse(request.params);

    const attachment = await prisma.attachment.findUnique({ where: { id } });
    if (!attachment || attachment.deletedAt) {
      throw Errors.notFound('附件不存在', 'ATTACHMENT_NOT_FOUND');
    }
    if (attachment.uploadedById !== auth.user.id && auth.user.role !== 'ADMIN') {
      throw Errors.forbidden('只能删除自己上传的附件');
    }

    await prisma.$transaction(async (tx) => {
      await tx.attachment.update({ where: { id }, data: { deletedAt: new Date() } });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'attachment.delete',
        resourceType: 'attachment',
        resourceId: id,
        before: { deletedAt: null, fileName: attachment.fileName },
        after: { deletedAt: new Date().toISOString(), fileName: attachment.fileName },
      });
    });

    return ok(reply, { id, deleted: true });
  });
}