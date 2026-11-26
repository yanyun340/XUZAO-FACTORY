import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { apiGet } from '../api/client';
import type { NotificationSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABEL } from '../lib/format';
import { BrandMark } from './BrandMark';
import { ToastHost } from './Toast';
import { LogOutIcon } from './Icons';
import { announce } from './LiveAnnouncer';

interface NavItem {
  to: string;
  index: string;
  label: string;
  adminOnly?: boolean;
  badgeKey?: 'notifications' | 'deviceApprovals';
}

/** 后台轮询间隔：兼顾「尽快看到」与本地服务压力。 */
const SUMMARY_POLL_MS = 15_000;

const NAV_ITEMS: NavItem[] = [
  { to: '/tasks', index: '01', label: '待办' },
  { to: '/', index: '02', label: '工厂看板' },
  { to: '/orders', index: '03', label: '订单总览' },
  { to: '/orders/new', index: '04', label: '新建订单', adminOnly: true },
  { to: '/inventory', index: '05', label: '库存' },
  { to: '/base-data', index: '06', label: '基础数据' },
  { to: '/exceptions', index: '07', label: '异常', adminOnly: true },
  { to: '/notifications', index: '08', label: '通知', badgeKey: 'notifications' },
  { to: '/audit', index: '09', label: '审计日志', adminOnly: true },
  { to: '/users', index: '10', label: '账号', adminOnly: true, badgeKey: 'deviceApprovals' },
];

function initials(name: string): string {
  return name.slice(0, 1);
}

function isActivePath(to: string, pathname: string): boolean {
  if (to === '/orders') {
    // 订单详情 /orders/:id 仍属于「订单总览」，但 /orders/new 归属「新建订单」
    return pathname === '/orders' || (pathname.startsWith('/orders/') && pathname !== '/orders/new');
  }
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [unread, setUnread] = useState(0);
  const [pendingDevices, setPendingDevices] = useState(0);
  const [deviceToast, setDeviceToast] = useState<number | null>(null);
  const lastPending = useRef<number | null>(null);

  const refreshSummary = useCallback(async () => {
    try {
      const summary = await apiGet<NotificationSummary>('/notifications/summary');
      setUnread(summary.unread);
      setPendingDevices(summary.pendingDevices);

      // 只在「首次发现」或数量上升时提醒，避免每轮轮询都弹一次
      const previous = lastPending.current;
      if (summary.pendingDevices > 0 && (previous === null || summary.pendingDevices > previous)) {
        setDeviceToast(summary.pendingDevices);
        announce(`有 ${summary.pendingDevices} 台设备等待批准`);
      }
      lastPending.current = summary.pendingDevices;
    } catch {
      // 角标失败不影响主流程，下一轮轮询会重试
    }
  }, []);

  // 换账号登录后重新建立基线，避免沿用上一个会话的待批准数量而漏报
  useEffect(() => {
    lastPending.current = null;
  }, [user?.id]);

  // 切换页面立即刷新，其余时间轮询：管理员不打开账号页也能收到设备审批提醒
  useEffect(() => {
    if (!user) return;
    void refreshSummary();

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSummary();
    }, SUMMARY_POLL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshSummary();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, pathname, refreshSummary]);

  // 提示条自动消失，管理员不在电脑前也不会一直挂着
  useEffect(() => {
    if (deviceToast === null) return;
    const timer = window.setTimeout(() => setDeviceToast(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [deviceToast]);

  if (!user) return null;

  const items = NAV_ITEMS.filter((item) => !item.adminOnly || user.role === 'ADMIN');
  // 当前项下标：桌面端由同一个指示块滑到该槽位，窄屏由 CSS 隐藏指示块
  const activeIndex = items.findIndex((item) => isActivePath(item.to, pathname));

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <>
      <div className="shell">
        <aside className="rail">
          <div className="rail__top">
            <div className="brand">
              <BrandMark className="brand__mark" size={30} />
              <span className="brand__text">
                <strong>序造</strong>
                <small>XUZAO / FACTORY OS</small>
              </span>
            </div>

            <nav
              className="rail__nav"
              aria-label="主导航"
              style={{ '--rail-active-index': Math.max(activeIndex, 0) } as CSSProperties}
            >
              {activeIndex >= 0 ? <span className="rail__indicator" aria-hidden /> : null}
              {items.map((item) => {
                const active = isActivePath(item.to, pathname);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`rail__link${active ? ' rail__link--active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span className="rail__index">{item.index}</span>
                    <span>{item.label}</span>
                    {item.badgeKey === 'notifications' && unread > 0 ? (
                      <span className="rail__badge mono" aria-label={`${unread} 条未读`}>
                        {unread > 99 ? '99+' : unread}
                      </span>
                    ) : null}
                    {item.badgeKey === 'deviceApprovals' && pendingDevices > 0 ? (
                      <span
                        className="rail__badge rail__badge--amber mono"
                        aria-label={`${pendingDevices} 台设备待批准`}
                      >
                        {pendingDevices > 99 ? '99+' : pendingDevices}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="rail__foot">
            <div className="rail__user">
              <span className="rail__avatar" aria-hidden>
                {initials(user.displayName)}
              </span>
              <span className="rail__identity">
                <strong>{user.displayName}</strong>
                <small>
                  {ROLE_LABEL[user.role]}
                  {user.department ? ` · ${user.department.name}` : ''}
                </small>
              </span>
              <button
                type="button"
                className="rail__logout"
                onClick={() => void handleLogout()}
                title="退出登录"
                aria-label="退出登录"
              >
                <LogOutIcon size={17} />
              </button>
            </div>
          </div>
        </aside>

        <main className="main">
          <Outlet />
        </main>

        <ToastHost />
      </div>

      {deviceToast !== null ? (
        <div className="device-toast" role="status">
          <span className="device-toast__dot" aria-hidden />
          <div className="device-toast__copy">
            <strong>{deviceToast} 台设备等待批准</strong>
            <small>有人在新设备上登录被拦截，批准后才能继续使用。</small>
          </div>
          <Link to="/users" className="device-toast__action" onClick={() => setDeviceToast(null)}>
            去处理
          </Link>
          <button
            type="button"
            className="device-toast__close"
            aria-label="关闭提示"
            onClick={() => setDeviceToast(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </>
  );
}