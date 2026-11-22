const STORAGE_KEY = 'xuzao_device_id';
const PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * 设备 ID：浏览器生成一次，存在 localStorage。
 * 这是弱凭据——清浏览器数据就丢，也能被手工复制；
 * 服务端把它当“方便审计与审批的线索”，不当安全边界。
 */
export function getDeviceId(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && PATTERN.test(stored)) return stored;

    const generated =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `dv-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

    window.localStorage.setItem(STORAGE_KEY, generated);
    return generated;
  } catch {
    // localStorage 被禁用（隐私模式等）：退化成一次性的内存值，刷新即变新设备。
    return `ephemeral-${Date.now().toString(36)}`;
  }
}

/** 给用户看的设备描述，仅用于展示，不参与鉴权。 */
export function getDeviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /Macintosh|Mac OS X/i.test(ua)
      ? 'macOS'
      : /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad|iOS/i.test(ua)
          ? 'iOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '未知系统';

  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /OPR\//i.test(ua)
      ? 'Opera'
      : /Firefox\//i.test(ua)
        ? 'Firefox'
        : /Chrome\//i.test(ua)
          ? 'Chrome'
          : /Safari\//i.test(ua)
            ? 'Safari'
            : '未知浏览器';

  return `${os} · ${browser}`;
}