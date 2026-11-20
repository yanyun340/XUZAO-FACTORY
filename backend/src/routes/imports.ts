import ExcelJS from 'exceljs';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext, requireAdmin } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import { Errors } from '../errors.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { ok } from '../http/respond.ts';
import { writeAudit } from '../lib/audit.ts';
import { buildWorkbook, sendXlsx, type XlsxColumn } from '../lib/export-workbook.ts';
import { nextCode } from '../lib/sequence.ts';
import { shanghaiDateKey } from '../lib/time.ts';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_ROWS = 500;

const entityParam = z.object({ entity: z.enum(['customer', 'supplier', 'part', 'employee']) });
const commitBody = z.object({ batchId: z.string().uuid('批次 ID 不合法') });

type EntityKey = 'customer' | 'supplier' | 'part' | 'employee';

interface ImportRow {
  rowNo: number;
  code: string | null;
  name: string;
  spec?: string;
  contact?: string | null;
  phone?: string | null;
  departmentCode?: string;
}

interface ImportIssue {
  rowNo: number;
  field: string;
  message: string;
}

interface EntityConfig {
  prismaEntity: 'CUSTOMER' | 'SUPPLIER' | 'PART' | 'EMPLOYEE';
  codeKind: string;
  codePrefix: string;
  headers: string[];
  columns: XlsxColumn[];
  example: string[];
  parse: (row: Record<string, string>, rowNo: number) => ImportRow | ImportIssue[];
  requiredColumns: string[];
  uniqueCodeTable: 'customer' | 'supplier' | 'part' | 'employee';
}

const CODE_PATTERN = /^[A-Za-z0-9_-]{2,30}$/;

function text(row: Record<string, string>, key: string): string {
  return (row[key] ?? '').trim();
}

function parseCommon(
  row: Record<string, string>,
  rowNo: number,
  options: { requireSpec?: boolean; requireDepartment?: boolean },
): ImportRow | ImportIssue[] {
  const issues: ImportIssue[] = [];
  const name = text(row, '名称') || text(row, '姓名');
  const code = text(row, '编码');

  if (!name) issues.push({ rowNo, field: '名称', message: '不能为空' });
  if (name.length > 100) issues.push({ rowNo, field: '名称', message: '不能超过 100 字' });
  if (code && !CODE_PATTERN.test(code)) {
    issues.push({ rowNo, field: '编码', message: '只能是 2-30 位字母、数字、下划线或短横线' });
  }

  const spec = text(row, '规格');
  if (options.requireSpec && !spec) {
    issues.push({ rowNo, field: '规格', message: '不能为空' });
  }
  if (spec.length > 200) issues.push({ rowNo, field: '规格', message: '不能超过 200 字' });

  const contact = text(row, '联系人');
  if (contact.length > 50) issues.push({ rowNo, field: '联系人', message: '不能超过 50 字' });

  const phone = text(row, '电话');
  if (phone.length > 30) issues.push({ rowNo, field: '电话', message: '不能超过 30 字' });

  const departmentCode = text(row, '部门编码');
  if (options.requireDepartment && !departmentCode) {
    issues.push({ rowNo, field: '部门编码', message: '不能为空' });
  }

  if (issues.length > 0) return issues;

  return {
    rowNo,
    code: code || null,
    name,
    ...(options.requireSpec ? { spec } : {}),
    ...(options.requireSpec ? {} : { contact, phone }),
    ...(options.requireDepartment ? { departmentCode } : {}),
  } as ImportRow;
}

const ENTITIES: Record<EntityKey, EntityConfig> = {
  customer: {
    prismaEntity: 'CUSTOMER',
    codeKind: 'customer',
    codePrefix: 'CUS',
    headers: ['名称', '联系人', '电话', '编码'],
    columns: [
      { header: '名称', width: 28 },
      { header: '联系人', width: 16 },
      { header: '电话', width: 20 },
      { header: '编码', width: 18 },
    ],
    example: ['示例客户', '王工', '13800000000', '（留空自动生成）'],
    requiredColumns: ['名称'],
    uniqueCodeTable: 'customer',
    parse: (row, rowNo) => parseCommon(row, rowNo, {}),
  },
  supplier: {
    prismaEntity: 'SUPPLIER',
    codeKind: 'supplier',
    codePrefix: 'SUP',
    headers: ['名称', '联系人', '电话', '编码'],
    columns: [
      { header: '名称', width: 28 },
      { header: '联系人', width: 16 },
      { header: '电话', width: 20 },
      { header: '编码', width: 18 },
    ],
    example: ['示例供应商', '李经理', '13900000000', '（留空自动生成）'],
    requiredColumns: ['名称'],
    uniqueCodeTable: 'supplier',
    parse: (row, rowNo) => parseCommon(row, rowNo, {}),
  },
  part: {
    prismaEntity: 'PART',
    codeKind: 'part',
    codePrefix: 'PRT',
    headers: ['名称', '规格', '编码'],
    columns: [
      { header: '名称', width: 28 },
      { header: '规格', width: 24 },
      { header: '编码', width: 18 },
    ],
    example: ['示例配件', 'DN50', '（留空自动生成）'],
    requiredColumns: ['名称', '规格'],
    uniqueCodeTable: 'part',
    parse: (row, rowNo) => parseCommon(row, rowNo, { requireSpec: true }),
  },
  employee: {
    prismaEntity: 'EMPLOYEE',
    codeKind: 'employee',
    codePrefix: 'EMP',
    headers: ['姓名', '部门编码', '编码'],
    columns: [
      { header: '姓名', width: 20 },
      { header: '部门编码', width: 18 },
      { header: '编码', width: 18 },
    ],
    example: ['示例员工', 'PROD', '（留空自动生成）'],
    requiredColumns: ['姓名', '部门编码'],
    uniqueCodeTable: 'employee',
    parse: (row, rowNo) => parseCommon(row, rowNo, { requireDepartment: true }),
  },
};

async function existingCodes(entity: EntityKey, codes: string[]): Promise<Set<string>> {
  if (codes.length === 0) return new Set();
  switch (entity) {
    case 'customer': {
      const rows = await prisma.customer.findMany({ where: { code: { in: codes } }, select: { code: true } });
      return new Set(rows.map((row) => row.code));
    }
    case 'supplier': {
      const rows = await prisma.supplier.findMany({ where: { code: { in: codes } }, select: { code: true } });
      return new Set(rows.map((row) => row.code));
    }
    case 'part': {
      const rows = await prisma.part.findMany({ where: { code: { in: codes } }, select: { code: true } });
      return new Set(rows.map((row) => row.code));
    }
    case 'employee': {
      const rows = await prisma.employee.findMany({ where: { code: { in: codes } }, select: { code: true } });
      return new Set(rows.map((row) => row.code));
    }
  }
}

function isIssueArray(value: ImportRow | ImportIssue[]): value is ImportIssue[] {
  return Array.isArray(value);
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 2 },
  });

  app.get(
    '/api/v1/imports/:entity/template.xlsx',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { entity } = entityParam.parse(request.params);
      const config = ENTITIES[entity];

      const workbook = buildWorkbook({
        sheetName: config.prismaEntity,
        columns: config.columns,
        rows: [config.example],
      });
      return sendXlsx(reply, workbook, `xuzao-import-${entity}-${shanghaiDateKey()}.xlsx`);
    },
  );

  app.post(
    '/api/v1/imports/:entity/preflight',
    { preHandler: [authenticate, requireAdmin], bodyLimit: MAX_IMPORT_BYTES + 64 * 1024 },
    async (request, reply) => {
      const auth = authContext(request);
      const { entity } = entityParam.parse(request.params);
      const config = ENTITIES[entity];

      const file = await request.file();
      if (!file) throw Errors.badRequest('请选择要导入的 xlsx 文件', 'IMPORT_FILE_REQUIRED');
      if (!/\.xlsx$/i.test(file.filename)) {
        throw Errors.badRequest('只支持 .xlsx 文件', 'IMPORT_TYPE_NOT_ALLOWED');
      }

      const buffer = await file.toBuffer();
      if (buffer.byteLength > MAX_IMPORT_BYTES) {
        throw Errors.badRequest('文件超过 2MB 限制', 'IMPORT_TOO_LARGE');
      }

      const workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      } catch {
        throw Errors.badRequest('文件不是有效的 xlsx', 'IMPORT_FILE_INVALID');
      }

      const sheet = workbook.worksheets[0];
      if (!sheet) throw Errors.badRequest('文件里没有工作表', 'IMPORT_SHEET_MISSING');

      const headerRow = sheet.getRow(1);
      const headers: string[] = [];
      for (let column = 1; column <= config.headers.length; column += 1) {
        headers.push(String(headerRow.getCell(column).text ?? '').trim());
      }
      const expected = config.headers;
      if (headers.length !== expected.length || headers.some((value, index) => value !== expected[index])) {
        throw Errors.badRequest(
          `表头不匹配，应为：${expected.join(' | ')}`,
          'IMPORT_HEADER_MISMATCH',
        );
      }

      const dataRows: Array<{ rowNo: number; values: Record<string, string> }> = [];
      for (let rowNo = 2; rowNo <= sheet.rowCount; rowNo += 1) {
        const row = sheet.getRow(rowNo);
        const values: Record<string, string> = {};
        expected.forEach((header, index) => {
          values[header] = String(row.getCell(index + 1).text ?? '').trim();
        });
        if (Object.values(values).every((value) => value === '')) continue;
        dataRows.push({ rowNo, values });
      }

      if (dataRows.length === 0) {
        throw Errors.badRequest('没有可导入的数据行', 'IMPORT_EMPTY');
      }
      if (dataRows.length > MAX_IMPORT_ROWS) {
        throw Errors.badRequest(
          `单次最多导入 ${MAX_IMPORT_ROWS} 行，当前 ${dataRows.length} 行`,
          'IMPORT_TOO_MANY_ROWS',
        );
      }

      const issues: ImportIssue[] = [];
      const parsed: ImportRow[] = [];
      for (const { rowNo, values } of dataRows) {
        const result = config.parse(values, rowNo);
        if (isIssueArray(result)) issues.push(...result);
        else parsed.push(result);
      }

      // 文件内重复编码
      const seen = new Map<string, number>();
      for (const row of parsed) {
        if (!row.code) continue;
        const previous = seen.get(row.code);
        if (previous) {
          issues.push({ rowNo: row.rowNo, field: '编码', message: `与第 ${previous} 行重复` });
        } else {
          seen.set(row.code, row.rowNo);
        }
      }

      // 与库内已有编码冲突
      const codes = [...seen.keys()];
      const existing = await existingCodes(entity, codes);
      for (const row of parsed) {
        if (row.code && existing.has(row.code)) {
          issues.push({ rowNo: row.rowNo, field: '编码', message: '编码已存在' });
        }
      }

      // 员工部门编码必须存在且启用
      if (entity === 'employee') {
        const departmentCodes = [
          ...new Set(parsed.map((row) => row.departmentCode!).filter(Boolean)),
        ];
        const departments = await prisma.department.findMany({
          where: { code: { in: departmentCodes } },
          select: { code: true, active: true },
        });
        const activeCodes = new Set(
          departments.filter((department) => department.active).map((department) => department.code),
        );
        for (const row of parsed) {
          if (row.departmentCode && !activeCodes.has(row.departmentCode)) {
            issues.push({
              rowNo: row.rowNo,
              field: '部门编码',
              message: '部门不存在或已停用',
            });
          }
        }
      }

      issues.sort((a, b) => a.rowNo - b.rowNo);

      const batch = await prisma.importBatch.create({
        data: {
          entity: config.prismaEntity,
          fileName: file.filename,
          rowCount: dataRows.length,
          errorCount: issues.length,
          errors: issues as unknown as Prisma.InputJsonValue,
          rows: parsed as unknown as Prisma.InputJsonValue,
          createdById: auth.user.id,
        },
      });

      return ok(
        reply,
        {
          batchId: batch.id,
          entity,
          rowCount: dataRows.length,
          errorCount: issues.length,
          errors: issues.slice(0, 100),
        },
        201,
      );
    },
  );

  app.post(
    '/api/v1/imports/:entity/commit',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { entity } = entityParam.parse(request.params);
      const config = ENTITIES[entity];
      const { batchId } = commitBody.parse(request.body);

      const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
      if (!batch || batch.entity !== config.prismaEntity) {
        throw Errors.notFound('导入批次不存在', 'IMPORT_BATCH_NOT_FOUND');
      }
      if (batch.status === 'COMMITTED') {
        throw Errors.conflict('IMPORT_ALREADY_COMMITTED', '该批次已经导入，不能重复提交');
      }
      if (batch.errorCount > 0) {
        throw Errors.business('预检存在错误行，修正后重新上传', 'IMPORT_HAS_ERRORS');
      }

      const rows = (batch.rows ?? []) as unknown as ImportRow[];
      if (!Array.isArray(rows) || rows.length === 0) {
        throw Errors.business('批次没有可导入的数据', 'IMPORT_EMPTY');
      }

      const committed = await prisma.$transaction(
        async (tx) => {
          for (const row of rows) {
            const code = row.code ?? (await nextCode(tx, config.codeKind, config.codePrefix));
            if (entity === 'customer') {
              await tx.customer.create({
                data: { code, name: row.name, contact: row.contact || null, phone: row.phone || null },
              });
            } else if (entity === 'supplier') {
              await tx.supplier.create({
                data: { code, name: row.name, contact: row.contact || null, phone: row.phone || null },
              });
            } else if (entity === 'part') {
              await tx.part.create({
                data: { code, name: row.name, spec: row.spec ?? '' },
              });
            } else {
              const department = await tx.department.findUnique({
                where: { code: row.departmentCode! },
              });
              if (!department || !department.active) {
                throw Errors.business(
                  `第 ${row.rowNo} 行的部门编码无效`,
                  'IMPORT_DEPARTMENT_INVALID',
                );
              }
              await tx.employee.create({
                data: { code, name: row.name, departmentId: department.id },
              });
            }
          }

          await tx.importBatch.update({
            where: { id: batch.id },
            data: { status: 'COMMITTED', committedAt: new Date(), rows: [] },
          });

          await writeAudit(tx, {
            requestId: request.id,
            actorId: auth.user.id,
            action: 'import.commit',
            resourceType: 'import_batch',
            resourceId: batch.id,
            after: { entity, rows: rows.length, fileName: batch.fileName },
          });

          return rows.length;
        },
        { timeout: 20_000 },
      );

      return ok(reply, { batchId: batch.id, entity, committed });
    },
  );
}