import type { CSSProperties } from 'react';
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
const BASE_RX = -24;
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

  return (
    <div className="sandbox" style={{ '--step': active } as CSSProperties}>
      <div className="sandbox__stage">
        <div
          className="sandbox__cube"
          style={{
            transform: `rotateX(${BASE_RX}deg) rotateY(${BASE_RY}deg) rotateX(${view.rx}deg) rotateY(${view.ry}deg)`,
          }}
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
                <span className="sandbox__icon">
                  <Icon size={18} />
                </span>
                <span className="sandbox__face-label">{item.label}</span>
                {/* 光带挂在面上，跟着面的 3D 变换走，才有「沿边流动」的透视感 */}
                {index === active ? <span className="sandbox__spark" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        当前环节：{stage.label}
      </p>
    </div>
  );
}