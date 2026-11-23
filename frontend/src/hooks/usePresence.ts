import { useEffect, useState } from 'react';

/**
 * 让带进场动画的浮层也能播完退场：open 变 false 后保留节点 exitMs，
 * 这期间调用方给容器加 leaving 类；真正卸载由这里负责。
 * 快速重开时清掉计时器，不会出现“刚关又开却被卸载”。
 */
export function usePresence(open: boolean, exitMs = 160) {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [open, mounted, exitMs]);

  return { mounted, leaving };
}