import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * 弹窗行为原语：Esc 关闭、Tab 焦点陷阱、打开时锁滚动、关闭后把焦点还给触发元素。
 *
 * 用法：
 *   const cardRef = useModalFocus(open, () => setOpen(false), { canClose: () => !busy });
 *   <form className="modal__card" ref={cardRef}>…</form>
 *
 * 初始焦点优先给卡片内的 `[data-autofocus]`，没有再取第一个可聚焦元素。
 * options.canClose 返回 false 时 Esc 不关闭（提交中防止丢输入）。
 */
export function useModalFocus(
  open: boolean,
  onClose: () => void,
  options: { canClose?: () => boolean } = {},
) {
  const cardRef = useRef<HTMLFormElement | null>(null);
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(options.canClose);
  onCloseRef.current = onClose;
  canCloseRef.current = options.canClose;

  useEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const initial =
      card?.querySelector<HTMLElement>('[data-autofocus]') ??
      card?.querySelector<HTMLElement>(FOCUSABLE) ??
      card;
    initial?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (canCloseRef.current && !canCloseRef.current()) return;
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !card) return;

      // 只在可见元素之间循环：隐藏分支（如新建/编辑二选一）里的控件不参与
      const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.getClientRects().length > 0,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !card.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !card.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      returnTo?.focus();
    };
  }, [open]);

  return cardRef;
}