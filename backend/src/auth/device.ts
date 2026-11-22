import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.ts';
import { Errors } from '../errors.ts';

type Tx = Prisma.TransactionClient;

const DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * 设备 ID 由浏览器生成并保存在 localStorage。
 * 这是弱凭据：能挡住“换台设备直接输密码”，挡不住手工复制；
 * 文档与状态表都按“弱绑定”描述，不宣称防伪造。
 */
export function normalizeDeviceKey(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return null;
  if (!DEVICE_KEY_PATTERN.test(trimmed)) {
    throw Errors.badRequest(
      '设备标识格式不合法（16-128 位字母、数字、下划线或短横线）',
      'DEVICE_KEY_INVALID',
    );
  }
  return trimmed;
}

/** 把 User-Agent 压成一句可读标签，只用于展示与审计，不作为身份依据。 */
export function deviceLabelFromUserAgent(userAgent: string | undefined): string {
  if (!userAgent) return '未知设备';

  const os = /Windows/i.test(userAgent)
    ? 'Windows'
    : /Macintosh|Mac OS X/i.test(userAgent)
      ? 'macOS'
      : /Android/i.test(userAgent)
        ? 'Android'
        : /iPhone|iPad|iOS/i.test(userAgent)
          ? 'iOS'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : '未知系统';

  const browser = /Edg\//i.test(userAgent)
    ? 'Edge'
    : /OPR\//i.test(userAgent)
      ? 'Opera'
      : /Firefox\//i.test(userAgent)
        ? 'Firefox'
        : /Chrome\//i.test(userAgent)
          ? 'Chrome'
          : /Safari\//i.test(userAgent)
            ? 'Safari'
            : '未知浏览器';

  return `${os} · ${browser}`;
}

/** 给现场人员报的短码，避免暴露原始设备 ID。 */
export function shortDeviceCode(deviceKey: string): string {
  return createHash('sha256').update(deviceKey).digest('hex').slice(0, 8).toUpperCase();
}

export type DeviceResolution =
  | { allowed: true; deviceId: string | null }
  | { allowed: false; deviceId: string; deviceCode: string; deviceLabel: string };

/**
 * 登录时的设备校验。
 * - 账号未开启受控设备：放行；已登记设备顺便刷新 lastSeenAt。
 * - 开启后：只认 ACTIVE 设备；未登记设备落一条 PENDING，等管理员批准。
 */
export async function resolveLoginDevice(
  tx: Tx,
  user: { id: string; deviceBindingMode: 'OFF' | 'ENFORCED' },
  deviceKey: string | null,
  userAgent: string | undefined,
): Promise<DeviceResolution> {
  const label = deviceLabelFromUserAgent(userAgent);

  if (user.deviceBindingMode === 'OFF') {
    if (!deviceKey) return { allowed: true, deviceId: null };

    const existing = await tx.device.findUnique({
      where: { userId_deviceKey: { userId: user.id, deviceKey } },
    });
    if (!existing) return { allowed: true, deviceId: null };

    if (existing.status === 'ACTIVE') {
      await tx.device.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
      return { allowed: true, deviceId: existing.id };
    }
    return { allowed: true, deviceId: null };
  }

  // ENFORCED：没有设备 ID 就等同于一台未登记设备，不能签发会话。
  if (!deviceKey) {
    return {
      allowed: false,
      deviceId: '',
      deviceCode: 'NO-DEVICE',
      deviceLabel: label,
    };
  }

  const existing = await tx.device.findUnique({
    where: { userId_deviceKey: { userId: user.id, deviceKey } },
  });

  if (existing?.status === 'ACTIVE') {
    await tx.device.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
    return { allowed: true, deviceId: existing.id };
  }

  if (existing) {
    // PENDING 保持等待；REVOKED 不再自动复活，必须管理员重新批准。
    return {
      allowed: false,
      deviceId: existing.id,
      deviceCode: shortDeviceCode(deviceKey),
      deviceLabel: existing.label,
    };
  }

  const created = await tx.device.create({
    data: {
      userId: user.id,
      deviceKey,
      label,
      userAgent: userAgent ?? null,
      status: 'PENDING',
      lastSeenAt: new Date(),
    },
  });

  return {
    allowed: false,
    deviceId: created.id,
    deviceCode: shortDeviceCode(deviceKey),
    deviceLabel: created.label,
  };
}

export interface DeviceRow {
  id: string;
  deviceKey: string;
  label: string;
  userAgent: string | null;
  status: string;
  lastSeenAt: Date | null;
  createdAt: Date;
}

/** 对外 DTO：不返回原始 deviceKey，只给短码，避免复制走就能直接冒用。 */
export function toDeviceDto(row: DeviceRow) {
  return {
    id: row.id,
    deviceCode: shortDeviceCode(row.deviceKey),
    label: row.label,
    userAgent: row.userAgent,
    status: row.status,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const DEVICE_KEY_PATTERN_SOURCE = DEVICE_KEY_PATTERN.source;