import { useEffect, useState, type CSSProperties } from 'react';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduce(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduce;
}

interface RollingNumberProps {
  /** 已格式化的金额，如 ¥415,035.00；只滚数字，货币符、千分位、小数点照常静态显示。 */
  value: string;
  /** 整行晚多久开始（毫秒）：四行利润依次起跳，而不是同时抖动。 */
  delay?: number;
}

/**
 * 数位滚动：每个数字位是一列 0-9，整列从 0 上移到目标位，
 * 数字位之间按 --digit-index 错峰，阅读顺序自左向右落位。
 * 屏幕阅读器读 sr-only 的完整字符串，不会听到十遍 0-9。
 */
export function RollingNumber({ value, delay = 0 }: RollingNumberProps) {
  const reduce = useReducedMotion();

  if (reduce) {
    return <span className="roll-number roll-number--static">{value}</span>;
  }

  let digitIndex = 0;

  return (
    <span className="roll-number">
      <span className="sr-only">{value}</span>
      <span
        className="roll-number__visual"
        aria-hidden
        style={{ '--roll-delay': `${delay}ms` } as CSSProperties}
      >
        {Array.from(value).map((char, position) => {
          if (!/\d/.test(char)) {
            return (
              <span className="roll-number__sep" key={`sep-${position}`}>
                {char}
              </span>
            );
          }
          return (
            <span className="counter-roll-container" key={`digit-${position}`}>
              <span
                className="counter-roll-digit"
                style={
                  {
                    '--counter-target': Number(char),
                    '--digit-index': digitIndex++,
                  } as CSSProperties
                }
              >
                <span className="counter-roll-column">
                  {DIGITS.map((digit) => (
                    <span key={digit}>{digit}</span>
                  ))}
                </span>
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}