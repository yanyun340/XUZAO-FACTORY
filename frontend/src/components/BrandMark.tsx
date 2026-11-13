import type { SVGProps } from 'react';

type BrandMarkProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * 序造 / XuZao 标志
 *
 * 2:1 等距线框立方体，单线、无填充、继承 currentColor。
 * 「序」的结构藏在几何里：
 *  - 广：顶面以近角为原点外扩 1.19×，形成出檐，檐下白缝即「一」的负空间
 *  - 予：近角引出的两条内折棱 ＋ 正面竖棱落到下尖点，收笔即「亅」的钩
 *
 * 每条棱单独成 path 并带 pathLength={1}，好让动效用同一个 dasharray
 * 归一化长度依次落笔，与「序」的字义同构。拆开后描边端点与原多边形
 * 路径完全重合（同为 square cap），静态外观不变。
 */
export function BrandMark({ size = 28, ...props }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
      focusable="false"
      {...props}
    >
      <path className="mark__stroke mark__body" pathLength={1} d="M16 6.41 25 11.6V22L16 27.19 7 22V11.6Z" />
      <path className="mark__stroke mark__fold mark__fold--a" pathLength={1} d="M16 16.8 25 11.6" />
      <path className="mark__stroke mark__fold mark__fold--b" pathLength={1} d="M16 16.8 7 11.6" />
      <path className="mark__stroke mark__spine" pathLength={1} d="M16 16.8V27.19" />
      <path className="mark__stroke mark__eave" pathLength={1} d="M16 4.81 26.39 10.8 16 16.8 5.61 10.8Z" />
    </svg>
  );
}