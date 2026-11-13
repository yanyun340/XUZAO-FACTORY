import { ChevronLeft, ChevronRight } from './Icons';

type PaginationProps = {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
};

/** 统一分页：只在多页时出现，文案与间距沿用既有 .pager 样式。 */
export function Pagination({ page, totalPages, onChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <nav className="pager" aria-label="分页">
      <button
        type="button"
        className="pager__btn"
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page <= 1}
      >
        <ChevronLeft size={16} />
        上一页
      </button>
      <span className="pager__status mono" aria-live="polite">
        {page} / {totalPages}
      </span>
      <button
        type="button"
        className="pager__btn"
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
      >
        下一页
        <ChevronRight size={16} />
      </button>
    </nav>
  );
}