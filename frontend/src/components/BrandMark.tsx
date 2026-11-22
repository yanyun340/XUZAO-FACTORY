import type { SVGProps } from 'react';

type BrandMarkProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * 序造 / XuZao 标志的几何来源：2:1 等距线框立方体，单线、无填充、继承 currentColor。
 *
 * 「序」的结构藏在几何里：
 *  - 广：顶面以近角为原点外扩 1.19×，形成出檐，檐下白缝即「一」的负空间
 *  - 予：近角引出的两条内折棱 ＋ 正面竖棱落到下尖点，收笔即「亅」的钩
 *
 * 导出成数据而不是只导出组件：落地页字标要把同一组棱线放大后嵌进字里，
 * 两处共用一份路径，改几何只改这里。
 */
export const BRAND_MARK_PATHS = [
  { key: 'body', className: 'mark__stroke mark__body', d: 'M16 6.41 25 11.6V22L16 27.19 7 22V11.6Z' },
  { key: 'fold-a', className: 'mark__stroke mark__fold mark__fold--a', d: 'M16 16.8 25 11.6' },
  { key: 'fold-b', className: 'mark__stroke mark__fold mark__fold--b', d: 'M16 16.8 7 11.6' },
  { key: 'spine', className: 'mark__stroke mark__spine', d: 'M16 16.8V27.19' },
  { key: 'eave', className: 'mark__stroke mark__eave', d: 'M16 4.81 26.39 10.8 16 16.8 5.61 10.8Z' },
] as const;

/** 立方体在 32×32 视图里的自然尺寸，放大时按它换算描边宽度。 */
export const BRAND_MARK_BOX = 32;

export function BrandMark({ size = 28, ...props }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${BRAND_MARK_BOX} ${BRAND_MARK_BOX}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
      focusable="false"
      {...props}
    >
      {BRAND_MARK_PATHS.map((path) => (
        <path
          key={path.key}
          className={path.className}
          pathLength={1}
          d={path.d}
        />
      ))}
    </svg>
  );
}