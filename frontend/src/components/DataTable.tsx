import { Fragment, type ReactNode } from 'react';

export type Column<T> = {
  /** 列标识，仅用于 React key */
  key: string;
  /** 表头内容；省略则渲染空表头单元格 */
  title?: ReactNode;
  /** 表头单元格类名（可与数据单元格不同，例如右对齐的数值列） */
  headClassName?: string;
  /** 数据单元格类名；传函数可按行给不同状态类 */
  className?: string | ((row: T) => string);
  /** 单元格渲染 */
  cell: (row: T) => ReactNode;
};

/**
 * 数据行之后的附加行（如展开详情）。
 * 渲染为独立的 <tr><td colSpan={列数}>，因此可以跨满整行；
 * render 返回 null 时不渲染该行。
 */
export type RowExpansion<T> = {
  rowClassName: string;
  cellClassName: string;
  render: (row: T) => ReactNode | null;
};

type DataTableProps<T> = {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** 外层滚动容器类名，沿用页面既有类（如 stock-table） */
  tableClassName: string;
  /** 表头行类名，本身需自带 grid-template-columns；没有表头时省略 */
  headClassName?: string;
  /** 数据行类名，本身需自带 grid-template-columns */
  rowClassName: string | ((row: T) => string);
  /** 无障碍名称 */
  label: string;
  /** 行数很少时不撑满滚动宽度 */
  minWidth?: number;
  /** 行密度；省略即现状（标准档） */
  density?: 'compact' | 'standard' | 'comfortable';
  /** 可选的展开行（跨满整行） */
  expansion?: RowExpansion<T>;
};

/**
 * 语义化表格：用原生 table/thead/tbody/tr/th/td 承担行列表义，
 * 视觉仍由调用方的 grid 类决定（display: block 化，不用 display: contents）。
 * 单元格不做 display 覆盖——grid 子项会自动 block 化，保持原有布局。
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  tableClassName,
  headClassName,
  rowClassName,
  label,
  minWidth,
  density,
  expansion,
}: DataTableProps<T>) {
  // 所有列都没给 title 时不渲染表头行（例如流水表本来就没有表头）
  const hasHead = columns.some((column) => column.title !== undefined);

  return (
    <table
      className={[
        tableClassName,
        'table-semantic',
        density === 'compact' ? 'table--compact' : '',
        density === 'comfortable' ? 'table--comfortable' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={label}
      style={minWidth ? ({ '--table-min': `${minWidth}px` } as React.CSSProperties) : undefined}
    >
      {hasHead ? (
        <thead>
          <tr className={headClassName}>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.headClassName}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
      ) : null}
      <tbody>
        {rows.map((row) => {
          const extra = expansion ? expansion.render(row) : null;
          return (
            <Fragment key={rowKey(row)}>
              <tr className={typeof rowClassName === 'function' ? rowClassName(row) : rowClassName}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={
                      typeof column.className === 'function' ? column.className(row) : column.className
                    }
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
              {expansion && extra ? (
                <tr className={expansion.rowClassName}>
                  <td colSpan={columns.length} className={expansion.cellClassName}>
                    {extra}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}