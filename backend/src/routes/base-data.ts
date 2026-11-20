import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext, requireAdmin } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import { Errors, isPrismaError } from '../errors.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { DepartmentCategory, SupplierType } from '../generated/prisma/enums.ts';
import { ok } from '../http/respond.ts';
import { writeAudit } from '../lib/audit.ts';
import { nextCode } from '../lib/sequence.ts';

const pageSchema = z.object({
  keyword: z.string().trim().max(100).optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const codeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{2,30}$/, '编码只能是 2-30 位字母、数字、下划线或短横线')
  .optional();

const idParam = z.object({ id: z.string().uuid('ID 不合法') });

/** 至少在修改一个字段，避免空 PATCH 写入无意义的审计。 */
function atLeastOneField<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).refine((value) => Object.keys(value).length > 0, {
    message: '没有需要修改的字段',
  });
}

function paged<T>(reply: FastifyReply, items: T[], total: number, page: number, pageSize: number) {
  return ok(reply, items, 200, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

export async function baseDataRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 客户 ----------
  app.get('/api/v1/customers', { preHandler: authenticate }, async (request, reply) => {
    const query = pageSchema.parse(request.query);
    const where: Prisma.CustomerWhereInput = {
      ...(query.active === undefined ? {} : { active: query.active }),
      ...(query.keyword
        ? {
            OR: [
              { name: { contains: query.keyword, mode: 'insensitive' } },
              { code: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, customers] = await prisma.$transaction([
      prisma.customer.count({ where }),
      prisma.customer.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return paged(reply, customers, total, query.page, query.pageSize);
  });

  app.post('/api/v1/customers', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const body = z
      .object({
        code: codeSchema,
        name: z.string().trim().min(1, '客户名称不能为空').max(100),
        contact: z.string().trim().max(50).optional(),
        phone: z.string().trim().max(30).optional(),
      })
      .parse(request.body);

    const customer = await prisma.$transaction(async (tx) => {
      const code = body.code ?? (await nextCode(tx, 'customer', 'CUS'));
      const created = await tx.customer.create({
        data: { code, name: body.name, contact: body.contact, phone: body.phone },
      });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'customer.create',
        resourceType: 'customer',
        resourceId: created.id,
        after: { code: created.code, name: created.name },
      });
      return created;
    });

    return ok(reply, customer, 201);
  });

  // ---------- 供应商 ----------
  app.get('/api/v1/suppliers', { preHandler: authenticate }, async (request, reply) => {
    const query = pageSchema.parse(request.query);
    const where: Prisma.SupplierWhereInput = {
      ...(query.active === undefined ? {} : { active: query.active }),
      ...(query.keyword
        ? {
            OR: [
              { name: { contains: query.keyword, mode: 'insensitive' } },
              { code: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, suppliers] = await prisma.$transaction([
      prisma.supplier.count({ where }),
      prisma.supplier.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return paged(reply, suppliers, total, query.page, query.pageSize);
  });

  app.post('/api/v1/suppliers', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const body = z
      .object({
        code: codeSchema,
        name: z.string().trim().min(1, '供应商名称不能为空').max(100),
        contact: z.string().trim().max(50).optional(),
        phone: z.string().trim().max(30).optional(),
        type: z.nativeEnum(SupplierType).default('NORMAL'),
      })
      .parse(request.body);

    const supplier = await prisma.$transaction(async (tx) => {
      const code = body.code ?? (await nextCode(tx, 'supplier', 'SUP'));
      const created = await tx.supplier.create({
        data: {
          code,
          name: body.name,
          contact: body.contact,
          phone: body.phone,
          type: body.type,
        },
      });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'supplier.create',
        resourceType: 'supplier',
        resourceId: created.id,
        after: { code: created.code, name: created.name, type: created.type },
      });
      return created;
    });

    return ok(reply, supplier, 201);
  });

  // ---------- 配件 ----------
  app.get('/api/v1/parts', { preHandler: authenticate }, async (request, reply) => {
    const query = pageSchema.parse(request.query);
    const where: Prisma.PartWhereInput = {
      ...(query.active === undefined ? {} : { active: query.active }),
      ...(query.keyword
        ? {
            OR: [
              { name: { contains: query.keyword, mode: 'insensitive' } },
              { code: { contains: query.keyword, mode: 'insensitive' } },
              { spec: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, parts] = await prisma.$transaction([
      prisma.part.count({ where }),
      prisma.part.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return paged(reply, parts, total, query.page, query.pageSize);
  });

  app.post('/api/v1/parts', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const body = z
      .object({
        code: codeSchema,
        name: z.string().trim().min(1, '配件名称不能为空').max(100),
        spec: z.string().trim().min(1, '规格不能为空').max(200),
      })
      .parse(request.body);

    const part = await prisma.$transaction(async (tx) => {
      const code = body.code ?? (await nextCode(tx, 'part', 'PRT'));
      // 新建配件同时建库存台账，避免后续调拨时出现「有配件无库存」的分叉状态
      const created = await tx.part.create({
        data: {
          code,
          name: body.name,
          spec: body.spec,
          inventory: { create: { quantity: 0 } },
        },
      });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'part.create',
        resourceType: 'part',
        resourceId: created.id,
        after: { code: created.code, name: created.name, spec: created.spec },
      });
      return created;
    });

    return ok(reply, part, 201);
  });

  // ---------- 部门 ----------
  app.get('/api/v1/departments', { preHandler: authenticate }, async (_request, reply) => {
    const departments = await prisma.department.findMany({
      orderBy: [{ category: 'asc' }, { code: 'asc' }],
      include: { _count: { select: { employees: true } } },
    });
    return ok(reply, departments);
  });

  app.post('/api/v1/departments', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const body = z
      .object({
        code: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_-]{2,30}$/, '部门编码只能是 2-30 位字母、数字、下划线或短横线'),
        name: z.string().trim().min(1, '部门名称不能为空').max(100),
        category: z.nativeEnum(DepartmentCategory),
      })
      .parse(request.body);

    const department = await prisma.$transaction(async (tx) => {
      const created = await tx.department.create({ data: body });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'department.create',
        resourceType: 'department',
        resourceId: created.id,
        after: { code: created.code, name: created.name, category: created.category },
      });
      return created;
    });

    return ok(reply, department, 201);
  });

  // ---------- 员工 ----------
  app.get('/api/v1/employees', { preHandler: authenticate }, async (request, reply) => {
    const query = pageSchema
      .extend({ departmentId: z.string().uuid().optional() })
      .parse(request.query);

    const where: Prisma.EmployeeWhereInput = {
      ...(query.active === undefined ? {} : { active: query.active }),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.keyword
        ? {
            OR: [
              { name: { contains: query.keyword, mode: 'insensitive' } },
              { code: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, employees] = await prisma.$transaction([
      prisma.employee.count({ where }),
      prisma.employee.findMany({
        where,
        include: { department: { select: { id: true, code: true, name: true, category: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return paged(reply, employees, total, query.page, query.pageSize);
  });

  app.post('/api/v1/employees', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const body = z
      .object({
        code: codeSchema,
        name: z.string().trim().min(1, '员工姓名不能为空').max(50),
        departmentId: z.string().uuid('部门 ID 不合法'),
      })
      .parse(request.body);

    const employee = await prisma.$transaction(async (tx) => {
      const department = await tx.department.findUnique({ where: { id: body.departmentId } });
      if (!department || !department.active) {
        throw Errors.business('部门不存在或已停用', 'DEPARTMENT_NOT_FOUND');
      }

      const code = body.code ?? (await nextCode(tx, 'employee', 'EMP'));
      const created = await tx.employee.create({
        data: { code, name: body.name, departmentId: department.id },
        include: { department: { select: { id: true, code: true, name: true, category: true } } },
      });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'employee.create',
        resourceType: 'employee',
        resourceId: created.id,
        after: { code: created.code, name: created.name, departmentId: created.departmentId },
      });
      return created;
    });

    return ok(reply, employee, 201);
  });

  // ---------- 修改与停用 ----------
  // 只改主数据本身；订单/采购里的名称、规格是快照，历史记录不跟着变。
  app.patch('/api/v1/customers/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = atLeastOneField({
      name: z.string().trim().min(1, '客户名称不能为空').max(100).optional(),
      contact: z.string().trim().max(50).nullable().optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      active: z.boolean().optional(),
    }).parse(request.body);

    const before = await prisma.customer.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('客户不存在', 'CUSTOMER_NOT_FOUND');

    const updated = await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.update({ where: { id }, data: body });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'customer.update',
        resourceType: 'customer',
        resourceId: id,
        before: { name: before.name, contact: before.contact, phone: before.phone, active: before.active },
        after: { name: customer.name, contact: customer.contact, phone: customer.phone, active: customer.active },
      });
      return customer;
    });

    return ok(reply, updated);
  });

  app.patch('/api/v1/suppliers/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = atLeastOneField({
      name: z.string().trim().min(1, '供应商名称不能为空').max(100).optional(),
      contact: z.string().trim().max(50).nullable().optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      type: z.nativeEnum(SupplierType).optional(),
      active: z.boolean().optional(),
    }).parse(request.body);

    const before = await prisma.supplier.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('供应商不存在', 'SUPPLIER_NOT_FOUND');

    const updated = await prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.update({ where: { id }, data: body });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'supplier.update',
        resourceType: 'supplier',
        resourceId: id,
        before: {
          name: before.name,
          contact: before.contact,
          phone: before.phone,
          type: before.type,
          active: before.active,
        },
        after: {
          name: supplier.name,
          contact: supplier.contact,
          phone: supplier.phone,
          type: supplier.type,
          active: supplier.active,
        },
      });
      return supplier;
    });

    return ok(reply, updated);
  });

  app.patch('/api/v1/parts/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = atLeastOneField({
      name: z.string().trim().min(1, '配件名称不能为空').max(100).optional(),
      spec: z.string().trim().min(1, '规格不能为空').max(200).optional(),
      active: z.boolean().optional(),
    }).parse(request.body);

    const before = await prisma.part.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('配件不存在', 'PART_NOT_FOUND');

    const updated = await prisma.$transaction(async (tx) => {
      const part = await tx.part.update({ where: { id }, data: body });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'part.update',
        resourceType: 'part',
        resourceId: id,
        before: { name: before.name, spec: before.spec, active: before.active },
        after: { name: part.name, spec: part.spec, active: part.active },
      });
      return part;
    });

    return ok(reply, updated);
  });

  // ---------- 配件-供应商（R02F） ----------
  app.get('/api/v1/parts/:id/suppliers', { preHandler: authenticate }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const part = await prisma.part.findUnique({ where: { id }, select: { id: true } });
    if (!part) throw Errors.notFound('配件不存在', 'PART_NOT_FOUND');

    const rows = await prisma.partSupplier.findMany({
      where: { partId: id },
      include: { supplier: { select: { code: true, name: true, type: true, active: true } } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    return ok(
      reply,
      rows.map((row) => ({
        id: row.id,
        partId: row.partId,
        supplierId: row.supplierId,
        supplierCode: row.supplier.code,
        supplierName: row.supplier.name,
        supplierType: row.supplier.type,
        supplierActive: row.supplier.active,
        isDefault: row.isDefault,
        createdAt: row.createdAt.toISOString(),
      })),
    );
  });

  app.post(
    '/api/v1/parts/:id/suppliers',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          supplierId: z.string().uuid('供应商 ID 不合法'),
          isDefault: z.boolean().default(false),
        })
        .parse(request.body);

      const part = await prisma.part.findUnique({ where: { id }, select: { id: true } });
      if (!part) throw Errors.notFound('配件不存在', 'PART_NOT_FOUND');

      const supplier = await prisma.supplier.findUnique({ where: { id: body.supplierId } });
      if (!supplier || !supplier.active) {
        throw Errors.business('供应商不存在或已停用', 'SUPPLIER_NOT_FOUND');
      }

      try {
        const created = await prisma.$transaction(async (tx) => {
          const existing = await tx.partSupplier.findUnique({
            where: { partId_supplierId: { partId: id, supplierId: body.supplierId } },
          });
          if (existing) {
            throw Errors.conflict('PART_SUPPLIER_EXISTS', '该供应商已经关联到此配件');
          }
          if (body.isDefault) {
            await tx.partSupplier.updateMany({
              where: { partId: id, isDefault: true },
              data: { isDefault: false },
            });
          }
          const row = await tx.partSupplier.create({
            data: { partId: id, supplierId: body.supplierId, isDefault: body.isDefault },
            include: { supplier: { select: { code: true, name: true, type: true, active: true } } },
          });
          await writeAudit(tx, {
            requestId: request.id,
            actorId: auth.user.id,
            action: 'part.supplier.add',
            resourceType: 'part',
            resourceId: id,
            after: {
              supplierId: row.supplierId,
              supplierName: row.supplier.name,
              isDefault: row.isDefault,
            },
          });
          return row;
        });

        return ok(
          reply,
          {
            id: created.id,
            partId: created.partId,
            supplierId: created.supplierId,
            supplierCode: created.supplier.code,
            supplierName: created.supplier.name,
            supplierType: created.supplier.type,
            supplierActive: created.supplier.active,
            isDefault: created.isDefault,
            createdAt: created.createdAt.toISOString(),
          },
          201,
        );
      } catch (error) {
        if (isPrismaError(error, 'P2002')) {
          throw Errors.conflict('DEFAULT_SUPPLIER_CONFLICT', '该配件已有默认供应商，请重试');
        }
        throw error;
      }
    },
  );

  app.patch(
    '/api/v1/parts/:id/suppliers/:supplierId',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = idParam.parse(request.params);
      const { supplierId } = z
        .object({ supplierId: z.string().uuid('供应商 ID 不合法') })
        .parse(request.params);
      const body = z.object({ isDefault: z.boolean() }).parse(request.body);

      const before = await prisma.partSupplier.findUnique({
        where: { partId_supplierId: { partId: id, supplierId } },
      });
      if (!before) throw Errors.notFound('配件与供应商没有关联', 'PART_SUPPLIER_NOT_FOUND');

      try {
        const updated = await prisma.$transaction(async (tx) => {
          if (body.isDefault) {
            await tx.partSupplier.updateMany({
              where: { partId: id, isDefault: true, supplierId: { not: supplierId } },
              data: { isDefault: false },
            });
          }
          const row = await tx.partSupplier.update({
            where: { partId_supplierId: { partId: id, supplierId } },
            data: { isDefault: body.isDefault },
          });
          await writeAudit(tx, {
            requestId: request.id,
            actorId: auth.user.id,
            action: 'part.supplier.default',
            resourceType: 'part',
            resourceId: id,
            before: { supplierId, isDefault: before.isDefault },
            after: { supplierId, isDefault: row.isDefault },
          });
          return row;
        });

        return ok(reply, {
          partId: updated.partId,
          supplierId: updated.supplierId,
          isDefault: updated.isDefault,
        });
      } catch (error) {
        if (isPrismaError(error, 'P2002')) {
          throw Errors.conflict('DEFAULT_SUPPLIER_CONFLICT', '并发设置默认供应商，请重试');
        }
        throw error;
      }
    },
  );

  app.delete(
    '/api/v1/parts/:id/suppliers/:supplierId',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = idParam.parse(request.params);
      const { supplierId } = z
        .object({ supplierId: z.string().uuid('供应商 ID 不合法') })
        .parse(request.params);

      const before = await prisma.partSupplier.findUnique({
        where: { partId_supplierId: { partId: id, supplierId } },
      });
      if (!before) throw Errors.notFound('配件与供应商没有关联', 'PART_SUPPLIER_NOT_FOUND');

      await prisma.$transaction(async (tx) => {
        await tx.partSupplier.delete({
          where: { partId_supplierId: { partId: id, supplierId } },
        });
        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'part.supplier.remove',
          resourceType: 'part',
          resourceId: id,
          before: { supplierId, isDefault: before.isDefault },
          after: { removed: true, supplierId },
        });
      });

      return ok(reply, { partId: id, supplierId, removed: true });
    },
  );

  app.patch('/api/v1/departments/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = atLeastOneField({
      name: z.string().trim().min(1, '部门名称不能为空').max(100).optional(),
      category: z.nativeEnum(DepartmentCategory).optional(),
      active: z.boolean().optional(),
      unitPriceVisible: z.boolean().optional(),
    }).parse(request.body);

    const before = await prisma.department.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('部门不存在', 'DEPARTMENT_NOT_FOUND');

    // 已有生产任务时改类别会让历史任务的归属含义变化，直接拒绝。
    if (body.category && body.category !== before.category) {
      const used = await prisma.productionOrder.count({ where: { departmentId: id } });
      if (used > 0) {
        throw Errors.conflict('DEPARTMENT_IN_USE', '该部门已有生产任务，不能再修改类别');
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const department = await tx.department.update({ where: { id }, data: body });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'department.update',
        resourceType: 'department',
        resourceId: id,
        before: {
          name: before.name,
          category: before.category,
          active: before.active,
          unitPriceVisible: before.unitPriceVisible,
        },
        after: {
          name: department.name,
          category: department.category,
          active: department.active,
          unitPriceVisible: department.unitPriceVisible,
        },
      });
      return department;
    });

    return ok(reply, updated);
  });

  app.patch('/api/v1/employees/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = atLeastOneField({
      name: z.string().trim().min(1, '员工姓名不能为空').max(50).optional(),
      departmentId: z.string().uuid('部门 ID 不合法').optional(),
      active: z.boolean().optional(),
    }).parse(request.body);

    const before = await prisma.employee.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('员工不存在', 'EMPLOYEE_NOT_FOUND');

    if (body.departmentId && body.departmentId !== before.departmentId) {
      const department = await prisma.department.findUnique({ where: { id: body.departmentId } });
      if (!department || !department.active) {
        throw Errors.business('部门不存在或已停用', 'DEPARTMENT_NOT_FOUND');
      }
      // 已承接任务的员工换部门会让历史任务归属混乱，先停用再新建更清楚。
      const used = await prisma.productionOrder.count({ where: { employeeId: id } });
      if (used > 0) {
        throw Errors.conflict('EMPLOYEE_IN_USE', '该员工已有生产任务，不能再修改所属部门');
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.update({
        where: { id },
        data: body,
        include: { department: { select: { id: true, code: true, name: true, category: true } } },
      });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'employee.update',
        resourceType: 'employee',
        resourceId: id,
        before: { name: before.name, departmentId: before.departmentId, active: before.active },
        after: { name: employee.name, departmentId: employee.departmentId, active: employee.active },
      });
      return employee;
    });

    return ok(reply, updated);
  });
}