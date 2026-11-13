import { useEffect, useRef, useState } from 'react';

export interface NavMenuRow {
  title: string;
  description?: string;
  /** 提供后整行变成可点按钮，用于直接回填登录账号等动作。 */
  onSelect?: () => void;
}

export interface NavMenu {
  id: string;
  label: string;
  groups: Array<{ heading?: string; rows: NavMenuRow[] }>;
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
    >
      <path
        d="M2 3.5 5 6.5 8 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 顶栏下拉导航：点击展开，同一时间只开一个；Esc 关闭并把焦点还给触发器，
 * 点面板外任意位置收起。面板内容为静态说明，行上带 onSelect 时那一行可点。
 */
export function DropdownNav({ menus, label = '产品导航' }: { menus: NavMenu[]; label?: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!openId) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenId(null);
      triggerRefs.current.get(openId)?.focus();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openId]);

  return (
    <nav className="login-nav" aria-label={label} ref={rootRef}>
      {menus.map((menu) => {
        const open = openId === menu.id;
        return (
          <div className="login-nav__item" key={menu.id}>
            <button
              ref={(element) => {
                if (element) triggerRefs.current.set(menu.id, element);
                else triggerRefs.current.delete(menu.id);
              }}
              type="button"
              className="login-nav__trigger"
              aria-expanded={open}
              aria-controls={`login-menu-${menu.id}`}
              onClick={() => setOpenId(open ? null : menu.id)}
            >
              {menu.label}
              <Chevron className="login-nav__chev" />
            </button>

            {open ? (
              <div
                className="login-nav__panel"
                id={`login-menu-${menu.id}`}
                role="group"
                aria-label={menu.label}
              >
                {menu.groups.map((group, index) => (
                  <div className="login-nav__group" key={group.heading ?? index}>
                    {group.heading ? (
                      <p className="login-nav__heading">{group.heading}</p>
                    ) : null}
                    <ul className="login-nav__list">
                      {group.rows.map((row) =>
                        row.onSelect ? (
                          <li key={row.title}>
                            <button
                              type="button"
                              className="login-nav__row login-nav__row--action"
                              onClick={() => {
                                row.onSelect?.();
                                setOpenId(null);
                              }}
                            >
                              <span className="login-nav__title">{row.title}</span>
                              {row.description ? (
                                <span className="login-nav__desc">{row.description}</span>
                              ) : null}
                            </button>
                          </li>
                        ) : (
                          <li key={row.title}>
                            <span className="login-nav__row">
                              <span className="login-nav__title">{row.title}</span>
                              {row.description ? (
                                <span className="login-nav__desc">{row.description}</span>
                              ) : null}
                            </span>
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}