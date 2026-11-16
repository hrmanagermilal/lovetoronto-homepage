export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function message(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map(item => {
      const text = typeof item?.msg === 'string' ? item.msg.replace(/^Value error, /, '') : '입력값 오류';
      const field = Array.isArray(item?.loc) ? item.loc.at(-1) : '';
      return field ? `${field}: ${text}` : text;
    }).join('\n');
  }
  if (status === 413) return '파일이 너무 큽니다.';
  if (status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도하십시오.';
  if (status === 403) return '권한이 없습니다.';
  return `요청이 실패했습니다 (HTTP ${status}).`;
}

export async function api<T = unknown>(path: string, options: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'lt-admin' };
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) body = options.form;
  const response = await fetch(`/api/admin${path}`, {
    method: options.method || (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin',
  });
  if (response.status === 204 || response.status === 202 && !response.headers.get('content-type')?.includes('json')) return undefined as T;
  let data: unknown = null;
  try { data = await response.json(); } catch { /* non-JSON error page */ }
  if (!response.ok) {
    const error = new ApiError(response.status, message((data as { detail?: unknown } | null)?.detail, response.status));
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('admin-signed-out'));
    throw error;
  }
  return data as T;
}

export async function upload(kind: 'hero' | 'thumbnail' | 'newsletter', file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  return (await api<{ url: string }>(`/uploads/${kind}`, { form })).url;
}

export interface Me {
  id: string; email: string; name: string; role: 'owner' | 'editor'; active: boolean;
  has_password: boolean; last_login_at: string | null; created_at: string;
}
export interface Slide {
  id: number; language: 'ko' | 'en'; position: number; image_url: string; alt: string; title: string;
  button_label: string; button_url: string; new_tab: boolean; active: boolean;
}
export interface NewsletterItem {
  id: number; title: string; file_url: string; thumbnail_url: string; published_on: string; active: boolean;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
}
