import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  CartIcon,
  GaugeIcon,
  GearIcon,
  InboxIcon,
  PackageIcon,
  TruckIcon,
} from './Icons';

export type FlowFace = 'front' | 'right' | 'back' | 'left' | 'top' | 'bottom';

export interface FlowStage {
  id: string;
  /** 面上的短标签，与底部进度条一致 */
  label: string;
  /** 对应立方体的哪一面 */
  face: FlowFace;
  icon: 'cart' | 'inbox' | 'gear' | 'gauge' | 'package' | 'truck';
}

/** 六个工序，改文案与图标只改这里；顺序必须与底部进度条一致。 */
export const FLOW_STAGES: FlowStage[] = [
  { id: 'purchase', label: '采购', face: 'front', icon: 'cart' },
  { id: 'arrival', label: '到货', face: 'right', icon: 'inbox' },
  { id: 'production', label: '生产', face: 'back', icon: 'gear' },
  { id: 'qc', label: '质检', face: 'left', icon: 'gauge' },
  { id: 'packing', label: '包装', face: 'top', icon: 'package' },
  { id: 'shipping', label: '发货', face: 'bottom', icon: 'truck' },
];

const ICONS = {
  cart: CartIcon,
  inbox: InboxIcon,
  gear: GearIcon,
  gauge: GaugeIcon,
  package: PackageIcon,
  truck: TruckIcon,
} as const;

/**
 * 等距基础角 + 每个面的反向旋转。
 * 不用正对镜头：正对时相邻两面会退化成一条线，看不出「当前面亮、邻面变暗」。
 */
const BASE_RX = -35.264;
const BASE_RY = -32;

const CUBE_VIEW: Record<FlowFace, { rx: number; ry: number }> = {
  front: { rx: 0, ry: 0 },
  right: { rx: 0, ry: -90 },
  back: { rx: 0, ry: 180 },
  left: { rx: 0, ry: 90 },
  /* 面自身是 rotateX(±90) 摆上去的，要把它转到正面就得反向旋转 */
  top: { rx: -90, ry: 0 },
  bottom: { rx: 90, ry: 0 },
};

/**
 * 入场线稿：把立方体在基础角下的 12 条棱投影成 9 条可见线（六边形轮廓 + 近角的 Y），
 * 和实体完全重合，填色时不会出现两套轮廓。
 * 数据由 rotateX(-35.264) rotateY(-32) + perspective 900/138 算出，viewBox 100（每单位 58）。
 */
const DRAFT_EDGES = [
  'M7.3 30.39 L41.15 5.13',
  'M41.15 5.13 L90.96 20.27',
  'M90.96 20.27 L87.55 67.25',
  'M87.55 67.25 L59.63 98.8',
  'M59.63 98.8 L10.99 78.32',
  'M10.99 78.32 L7.3 30.39',
  'M60.61 49.3 L7.3 30.39',
  'M60.61 49.3 L90.96 20.27',
  'M60.61 49.3 L59.63 98.8',
] as const;

/**
 * 同一个姿态可以用 raw + 360k 表示。取离当前角度最近的那个，
 * 让 CSS 的角度插值走最短路径，而不是每次都从 0 甩到 180。
 */
function nearestAngle(current: number, raw: number) {
  return raw + 360 * Math.round((current - raw) / 360);
}

/**
 * 立方体本身不持有状态：`active` 由页面里的底部进度条驱动，
 * 点面也回传同一个 setter，两条入口共用一个状态。
 */
export function LandingFlowSandbox({
  active,
  onSelect,
}: {
  active: number;
  onSelect: (index: number) => void;
}) {
  const stage = FLOW_STAGES[active] ?? FLOW_STAGES[0];
  const view = CUBE_VIEW[stage.face];

  // 入场动画：线框按绘图机的节奏揭开，六面再依次填色。减少动态时直接进终态。
  const [entered, setEntered] = useState(
    () =>
      typeof window === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (entered) return;
    const timer = window.setTimeout(() => setEntered(true), 1050);
    return () => window.clearTimeout(timer);
  }, [entered]);

  // 累积角度：记录已提交的视图角，翻面时取最近的等价角，避免长路径翻滚
  const angleRef = useRef({ rx: view.rx, ry: view.ry });
  const rx = nearestAngle(angleRef.current.rx, view.rx);
  const ry = nearestAngle(angleRef.current.ry, view.ry);
  const travel =
    Math.abs(rx - angleRef.current.rx) + Math.abs(ry - angleRef.current.ry);

  useEffect(() => {
    angleRef.current = { rx, ry };
  }, [rx, ry]);

  return (
    <div
      className={`sandbox${entered ? ' sandbox--entered' : ''}`}
      style={{ '--step': active } as CSSProperties}
    >
      <div className="sandbox__stage">
        {/* 入场线稿：与字标同一套逐段落笔，但画的是这枚方块自己的棱 */}
        <svg className="sandbox__draft" viewBox="0 0 100 100" aria-hidden focusable="false">
          {DRAFT_EDGES.map((d, i) => (
            <path
              key={d}
              d={d}
              pathLength={1}
              style={{ animationDelay: `${i * 55}ms` }}
            />
          ))}
        </svg>
        <div className="sandbox__plot">
        <div
          className="sandbox__cube"
          style={
            {
              transform: `rotateX(${BASE_RX}deg) rotateY(${BASE_RY}deg) rotateX(${rx}deg) rotateY(${ry}deg)`,
              /* 180° 的翻转（上下两面互转）多给 100ms，其余保持同一节拍 */
              '--turn-ms': travel > 120 ? '620ms' : '520ms',
            } as CSSProperties
          }
        >
          {FLOW_STAGES.map((item, index) => {
            const Icon = ICONS[item.icon];
            return (
              <button
                key={item.id}
                type="button"
                className={`sandbox__face sandbox__face--${item.face}`}
                data-state={index === active ? 'active' : 'idle'}
                aria-label={`查看${item.label}环节`}
                tabIndex={-1}
                onClick={() => onSelect(index)}
              >
                <span className="sandbox__face-index" aria-hidden>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="sandbox__face-inner">
                  <span className="sandbox__icon">
                    <Icon size={18} />
                  </span>
                  <span className="sandbox__face-label">{item.label}</span>
                </span>
                {/* 光带挂在面上，跟着面的 3D 变换走，才有「沿边流动」的透视感。
                    六个面都挂，靠负延迟错开相位；只有当前面在跑，翻面时不会重头闪 */}
                <span
                  className="sandbox__spark"
                  aria-hidden
                  style={{ '--spark-phase': `-${index * 0.37}s` } as CSSProperties}
                >
                  <i />
                </span>
              </button>
            );
          })}
        </div>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        当前环节：{stage.label}
      </p>
    </div>
  );
}