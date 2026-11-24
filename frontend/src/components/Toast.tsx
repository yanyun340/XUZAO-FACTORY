import { useEffect, useState } from 'react';

export type ToastTone = 'success' | 'info' | 'error';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  leaving?: boolean;
}

const VISIBLE_MS = 3000;
const EXIT_MS = 140;
const MAX = 3;

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<(next: ToastItem[]) => void>();

function emit() {
  for (const listener of listeners) listener(items);
}

function dismiss(id: number) {
  items = items.map((item) => (item.id === id ? { ...item, leaving: true } : item));
  emit();
  window.setTimeout(() => {
    items = items.filter((item) => item.id !== id);
    emit();
  }, EXIT_MS);
}

/**
 * 右下角的轻量确认。屏幕阅读器仍走 announce()，这里只做视觉反馈，
 * 因此容器是 aria-hidden，不会重复播报。
 */
export function toast(message: string, tone: ToastTone = 'success') {
  const id = ++seq;
  items = [...items, { id, message, tone }].slice(-MAX);
  emit();
  window.setTimeout(() => dismiss(id), VISIBLE_MS);
}

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);

  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  return (
    <div className="toast-stack" aria-hidden="true">
      {list.map((item) => (
        <div
          key={item.id}
          className={`toast toast--${item.tone}${item.leaving ? ' is-leaving' : ''}`}
        >
          <span className="toast__dot" />
          <span className="toast__text">{item.message}</span>
        </div>
      ))}
    </div>
  );
}