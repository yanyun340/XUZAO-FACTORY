import { useCallback, useRef, useState } from 'react';

/**
 * 给自持 open 状态的弹窗补退场：requestClose 先挂 leaving 类，
 * 动画时长过后再执行真正的关闭；重复点击只算一次。
 */
export function useExitClose(onClose: () => void, ms = 160) {
  const [leaving, setLeaving] = useState(false);
  const closing = useRef(false);

  const requestClose = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setLeaving(true);
    window.setTimeout(() => {
      onClose();
      closing.current = false;
      setLeaving(false);
    }, ms);
  }, [onClose, ms]);

  return { leaving, requestClose };
}