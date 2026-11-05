import type { Envelope } from './types';

const API_BASE = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(
    message: string,
    status: number,
    code: string,
    details: unknown = null,
    requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

let unauthorizedHandler: (() => void) | null = null;

/** AuthProvider 注册：会话过期时全局退回登录页。 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

interface ErrorPayload {
  error?: { code?: string; message?: string; details?: unknown };
  meta?: { requestId?: string };
}

function toApiError(response: Response, payload: ErrorPayload | null): ApiError {
  const error = payload?.error;
  const message = error?.message ?? `请求失败（HTTP ${response.status}）`;
  const code = error?.code ?? 'HTTP_ERROR';

  if (response.status === 401 && code !== 'AUTH_INVALID_CREDENTIALS') {
    unauthorizedHandler?.();
  }

  return new ApiError(
    message,
    response.status,
    code,
    error?.details,
    payload?.meta?.requestId ?? null,
  );
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const { method = 'GET', body, headers } = options;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('网络连接失败，请检查服务是否启动', 0, 'NETWORK_ERROR');
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; meta?: Envelope<T>['meta']; error?: { code?: string; message?: string; details?: unknown } }
    | null;

  if (!response.ok) {
    throw toApiError(response, payload);
  }

  if (!payload || payload.data === undefined) {
    throw new ApiError('服务返回了无法识别的数据', response.status, 'BAD_RESPONSE');
  }

  return {
    data: payload.data,
    meta: payload.meta ?? { requestId: '', page: 1, pageSize: 0, total: 0, totalPages: 1 },
  };
}

export async function apiGet<T>(path: string): Promise<T> {
  return (await request<T>(path)).data;
}

export async function apiGetPage<T>(path: string): Promise<Envelope<T>> {
  return request<T>(path);
}

export async function apiPost<T>(
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  return (await request<T>(path, { method: 'POST', body, headers })).data;
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return (await request<T>(path, { method: 'PATCH', body })).data;
}

/** multipart 上传：不设置 Content-Type，交给浏览器补 boundary。 */
export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      body: form,
    });
  } catch {
    throw new ApiError('网络连接失败，请检查服务是否启动', 0, 'NETWORK_ERROR');
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code?: string; message?: string; details?: unknown } }
    | null;

  if (!response.ok) throw toApiError(response, payload);
  if (!payload || payload.data === undefined) {
    throw new ApiError('服务返回了无法识别的数据', response.status, 'BAD_RESPONSE');
  }
  return payload.data;
}

function fileNameFromDisposition(header: string | null): string {
  if (!header) return 'download';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? 'download';
}

/** 下载二进制响应（导出 / 附件），失败时仍按统一错误信封解析。 */
export async function apiDownload(path: string): Promise<{ blob: Blob; fileName: string }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: 'same-origin',
      headers: { Accept: '*/*' },
    });
  } catch {
    throw new ApiError('网络连接失败，请检查服务是否启动', 0, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
    throw toApiError(response, payload);
  }

  return {
    blob: await response.blob(),
    fileName: fileNameFromDisposition(response.headers.get('Content-Disposition')),
  };
}