import { useEffect, useState, type CSSProperties } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { apiGet } from '../api/client';
import type { NotificationSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABEL } from '../lib/format';
import { BrandMark } from './BrandMark';
import { BoxIcon, LogOutIcon } from './Icons';

interface NavItem {
  to: string;
  index: string;
  label: string;
  adminOnly?: boolean;
  badgeKey?: 'notifications';
}

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
  { to: '/users', index: '10', label: '账号', adminOnly: true },
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

  // 每次切换页面刷新未读数：完成一步流转后，管理员能立刻看到角标变化
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    apiGet<NotificationSummary>('/notifications/summary')
      .then((summary) => {
        if (!cancelled) setUnread(summary.unread);
      })
      .catch(() => {
        // 角标失败不影响主流程
      });
    return () => {
      cancelled = true;
    };
  }, [user, pathname]);

  if (!user) return null;

  const items = NAV_ITEMS.filter((item) => !item.adminOnly || user.role === 'ADMIN');
  // 当前项下标：桌面端由同一个指示块滑到该槽位，窄屏由 CSS 隐藏指示块
  const activeIndex = items.findIndex((item) => isActivePath(item.to, pathname));

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
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
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="rail__foot">
          <div className="rail__hint">
            <BoxIcon size={15} />
            <span>一单到底</span>
          </div>
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
    </div>
  );
}