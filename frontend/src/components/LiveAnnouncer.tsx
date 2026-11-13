import { useEffect, useState } from 'react';

type AnnounceFn = (message: string) => void;

let deliver: AnnounceFn = () => {};

/** 让屏幕阅读器播报一句操作结果。LiveAnnouncer 需在 App 根挂载一次。 */
export function announce(message: string) {
  deliver(message);
}

/**
 * 全局礼貌播报区。先清空再下一帧写入，保证同一句文案重复触发时仍会被读出来。
 * 页面级的 aria-live 只能表达「这块内容变了」，这里表达「你刚做的那件事成功了」。
 */
export function LiveAnnouncer() {
  const [message, setMessage] = useState('');

  useEffect(() => {
    deliver = (next) => {
      setMessage('');
      requestAnimationFrame(() => setMessage(next));
    };
    return () => {
      deliver = () => {};
    };
  }, []);

  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </p>
  );
}