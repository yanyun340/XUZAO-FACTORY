import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { DropdownNav, type NavMenu } from '../components/DropdownNav';
import { BrandMark } from '../components/BrandMark';
import { BrandWordmark } from '../components/BrandWordmark';
import { LandingFlowSandbox } from '../components/LandingFlowSandbox';
import { Field, InlineNotice } from '../components/ui';
import { ArrowUpRight, CloseIcon } from '../components/Icons';

const DEMO_ACCOUNTS = [
  { username: 'admin', label: '管理员' },
  { username: 'logistics', label: '物流' },
  { username: 'production', label: '生产' },
  { username: 'qc', label: '品控' },
  { username: 'packing', label: '包装' },
];

const STEP_MS = 1800;
const FLOW = ['采购', '到货', '生产', '质检', '包装', '发货'];

export function LoginPage() {
  const { user, login, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [active, setActive] = useState(0);
  // 系统要求减少动态效果时不自动播放，避免每 1.8s 直接闪一下
  const [playing, setPlaying] = useState(
    () =>
      typeof window === 'undefined' ||
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [loginOpen, setLoginOpen] = useState(false);
  const activeRef = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const focusPasswordRef = useRef(false);
  const glowRef = useRef<HTMLDivElement>(null);

  // 指针色斑：只写 transform，rAF 内做指数平滑，避免每帧触发样式重算
  useEffect(() => {
    const glow = glowRef.current;
    if (!glow) return;

    const canHover = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    let frame = 0;
    let currentX = 0;
    let currentY = 0;
    let targetX = 0;
    let targetY = 0;
    let primed = false;

    const render = () => {
      frame = 0;
      const dx = targetX - currentX;
      const dy = targetY - currentY;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        currentX = targetX;
        currentY = targetY;
      } else {
        currentX += dx * 0.16;
        currentY += dy * 0.16;
        frame = window.requestAnimationFrame(render);
      }
      glow.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
    };

    const handleMove = (event: PointerEvent) => {
      if (!canHover.matches || reduceMotion.matches) return;
      targetX = event.clientX;
      targetY = event.clientY;
      if (!primed) {
        primed = true;
        currentX = targetX;
        currentY = targetY;
        glow.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
        glow.classList.add('is-active');
      }
      if (!frame) frame = window.requestAnimationFrame(render);
    };

    const handleLeave = () => {
      primed = false;
      glow.classList.remove('is-active');
    };

    window.addEventListener('pointermove', handleMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', handleLeave);
    window.addEventListener('blur', handleLeave);

    return () => {
      window.removeEventListener('pointermove', handleMove);
      document.documentElement.removeEventListener('pointerleave', handleLeave);
      window.removeEventListener('blur', handleLeave);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  // 进入页面自动从 01 播到 06，播完停在 06；手动点击节点后同样暂停
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const next = activeRef.current + 1;
      if (next >= FLOW.length) {
        setPlaying(false);
        return;
      }
      activeRef.current = next;
      setActive(next);
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [playing]);

  const selectStep = (index: number) => {
    setPlaying(false);
    activeRef.current = index;
    setActive(index);
  };

  /** 登录卡不再常驻：由导航或主按钮触发，弹层打开后再把焦点落到输入框。 */
  const openLogin = (presetUsername?: string) => {
    if (presetUsername) {
      setUsername(presetUsername);
      setPassword('');
      focusPasswordRef.current = true;
    }
    setError(null);
    setDeviceCode(null);
    setLoginOpen(true);
  };

  const closeLogin = () => {
    dialogRef.current?.close();
  };

  // 原生 dialog 负责焦点捕获与 Esc；这里只同步 showModal 与 React 状态
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (loginOpen && !dialog.open) {
      dialog.showModal();
      const targetId = focusPasswordRef.current ? 'password' : 'username';
      focusPasswordRef.current = false;
      window.requestAnimationFrame(() => document.getElementById(targetId)?.focus());
    }
  }, [loginOpen]);

  const handleDialogClose = () => {
    setLoginOpen(false);
  };

  const handleDialogClick = (event: ReactMouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) closeLogin();
  };

  // 登录成功也停在首页：工作台只能从「进入系统」进入。
  // 若之前是被 RequireAuth 从某个内页踢回来的，进入系统后回到那一页。
  const from = (location.state as { from?: string } | null)?.from ?? '/orders';
  const enterTarget = from.startsWith('/') ? from : '/orders';

  const handleEnter = () => {
    if (user) {
      navigate(enterTarget, { replace: true });
      return;
    }
    openLogin();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setDeviceCode(null);

    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }

    setSubmitting(true);
    try {
      await login(username.trim(), password);
      setSubmitting(false);
      setPassword('');
      closeLogin();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'DEVICE_NOT_ALLOWED') {
        const details = caught.details as { deviceCode?: string } | null;
        setError('这台设备还没有被授权。请把下面的设备码报给管理员，批准后再登录。');
        setDeviceCode(details?.deviceCode ?? null);
      } else {
        setError(caught instanceof ApiError ? caught.message : '登录失败，请稍后重试');
      }
      setSubmitting(false);
    }
  };

  const selectDemo = (value: string) => {
    openLogin(value);
  };

  const menus: NavMenu[] = [
    {
      id: 'flow',
      label: '功能',
      groups: [
        {
          heading: '订单主线',
          rows: [
            { title: '订单全链路' },
            { title: '采购与到货' },
            { title: '生产与报工' },
            { title: '质检放行' },
            { title: '包装与发货' },
          ],
        },
      ],
    },
    {
      id: 'roles',
      label: '角色',
      groups: [
        {
          heading: '五个岗位',
          rows: DEMO_ACCOUNTS.map((account) => ({
            title: account.label,
            onSelect: () => selectDemo(account.username),
          })),
        },
      ],
    },
    {
      id: 'deploy',
      label: '部署',
      groups: [
        {
          heading: '运行方式',
          rows: [
            { title: '本地部署' },
            { title: '演示数据' },
            { title: '权限与审计' },
          ],
        },
      ],
    },
  ];

  return (
    <div className="landing">
      <div ref={glowRef} className="landing__glow" aria-hidden />

      <header className="landing__nav">
        <div className="login__nav-left">
          <div className="login__brand-top">
            <BrandMark className="brand__mark brand__mark--light" size={30} />
            <span className="login__brand-lockup">
              <strong className="login__brand-name">序造</strong>
              <span className="login__brand-latin mono" aria-hidden>
                XUZAO / FACTORY OS
              </span>
            </span>
          </div>
          <DropdownNav menus={menus} />
        </div>
        {user ? (
          <div className="landing__account">
            <span className="landing__account-name">{user.displayName}</span>
            <button
              type="button"
              className="landing__account-exit"
              onClick={() => void logout()}
            >
              退出登录
            </button>
          </div>
        ) : (
          <button type="button" className="landing__nav-cta" onClick={() => openLogin()}>
            登录
          </button>
        )}
      </header>

      <main className="landing__hero">
        <h1 className="sr-only">序造</h1>
        <BrandWordmark />
        <p className="landing__tagline">一单到底 · 全厂协同</p>
        {/* 身份提示绝对定位在 CTA 下方：登录前后不改变 hero 高度，
            否则整块舞台（方块 + 进度条）会被顶下去 35px */}
        <div className="landing__cta">
          <button type="button" className="landing__hero-cta" onClick={handleEnter}>
            进入系统
          </button>
          {user ? (
            <p className="landing__signed-in" role="status">
              已登录 · {user.displayName}
            </p>
          ) : null}
        </div>
      </main>

      <section className="landing__stage" aria-label="订单流转演示">
        <LandingFlowSandbox active={active} onSelect={selectStep} />
        <div className="landing__demo">
          <div className="login__flowbar">
            <div className="flow" role="group" aria-label="订单流程演示，点击任意节点查看该环节">
              <div className="flow__rail">
                <span
                  className="flow__fill"
                  style={{ transform: `scaleX(${active / (FLOW.length - 1)})` }}
                />
                <span
                  className="flow__dot"
                  style={{ '--flow-p': active / (FLOW.length - 1) } as CSSProperties}
                />
              </div>
              <div className="flow__nodes">
                {FLOW.map((step, index) => (
                  <button
                    type="button"
                    key={step}
                    className={`flow__node${index < active ? ' is-done' : ''}${
                      index === active ? ' is-active' : ''
                    }`}
                    aria-label={`第 ${index + 1} 步：${step}`}
                    aria-pressed={index === active}
                    onClick={() => selectStep(index)}
                  >
                    <span className="flow__num">{String(index + 1).padStart(2, '0')}</span>
                    <span className="flow__mark" />
                    <span className="flow__label">{step}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <dialog
        ref={dialogRef}
        className="login-modal"
        aria-labelledby="login-title"
        onClose={handleDialogClose}
        onClick={handleDialogClick}
      >
        <div className="login-modal__card">
          <button type="button" className="login-modal__close" onClick={closeLogin} aria-label="关闭登录">
            <CloseIcon size={18} />
          </button>

          <aside className="login-modal__brand" aria-label="序造 XuZao">
            <BrandMark className="brand__mark" size={64} />
            <span className="login-modal__wordmark">
              <strong>序造</strong>
              <span className="mono">XUZAO / FACTORY OS</span>
            </span>
            <p className="login-modal__meta mono">本地部署 · 演示环境</p>
            <BrandMark className="login-modal__watermark" size={220} aria-hidden />
          </aside>

          <div className="login-modal__panel">
            <div className="login__card-head">
              <h2 className="login__card-title" id="login-title">
                登录工作台
              </h2>
            </div>

            <form className="login__form" onSubmit={(event) => void handleSubmit(event)}>
              <Field label="用户名" htmlFor="username" required>
                <input
                  id="username"
                  className="input"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="例如 admin"
                />
              </Field>

              <Field label="密码" htmlFor="password" required>
                <div className="input-wrap">
                  <input
                    id="password"
                    className="input input--password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="输入登录密码"
                  />
                  <button
                    type="button"
                    className="input-reveal"
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? '隐藏' : '显示'}
                  </button>
                </div>
              </Field>

              {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

              {deviceCode ? (
                <div className="device-code">
                  <span className="device-code__label">设备码</span>
                  <code className="device-code__value">{deviceCode}</code>
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => {
                      if (deviceCode) void navigator.clipboard?.writeText(deviceCode);
                    }}
                  >
                    复制
                  </button>
                </div>
              ) : null}

              <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
                <span className="btn__label">{submitting ? '正在验证…' : '登录'}</span>
                <span className="btn__trailing">
                  <ArrowUpRight size={16} />
                </span>
              </button>
            </form>

            <div className="login__demo" role="group" aria-label="演示账号">
              <div className="login__demo-chips">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    type="button"
                    key={account.username}
                    className={`chip${username === account.username ? ' chip--active' : ''}`}
                    onClick={() => {
                      setUsername(account.username);
                      setError(null);
                    }}
                  >
                    {account.label}
                    <code>{account.username}</code>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </dialog>
    </div>
  );
}