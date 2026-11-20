import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';

export interface XlsxColumn {
  header: string;
  width: number;
  numFmt?: string;
}

export interface XlsxSheetInput {
  sheetName: string;
  columns: XlsxColumn[];
  rows: Array<Array<string | number | null>>;
}

/**
 * 统一 xlsx 版式：冻结表头、加粗表头、按列宽、可选数字格式、自动筛选。
 * 订单、审计以及后续报表共用，避免每个导出各写一套样式。
 */
export function buildWorkbook(input: XlsxSheetInput): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '序造 XuZao';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(input.sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = input.columns.map((column) => ({ width: column.width }));

  const header = sheet.addRow(input.columns.map((column) => column.header));
  header.font = { bold: true };
  header.alignment = { vertical: 'middle' };
  header.height = 22;

  for (const values of input.rows) {
    sheet.addRow(values);
  }

  input.columns.forEach((column, index) => {
    if (!column.numFmt) return;
    for (let row = 2; row <= input.rows.length + 1; row += 1) {
      sheet.getRow(row).getCell(index + 1).numFmt = column.numFmt;
    }
  });

  if (input.rows.length > 0) {
    const lastColumn = String.fromCharCode(64 + input.columns.length);
    sheet.autoFilter = { from: 'A1', to: `${lastColumn}${input.rows.length + 1}` };
  }

  return workbook;
}

export async function sendXlsx(
  reply: FastifyReply,
  workbook: ExcelJS.Workbook,
  fileName: string,
): Promise<void> {
  const buffer = await workbook.xlsx.writeBuffer();
  reply.header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  reply.header(
    'Content-Disposition',
    `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  reply.send(Buffer.from(buffer));
}