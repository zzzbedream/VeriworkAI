import { vi } from 'vitest';

export interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface MockReply {
  readonly status: number;
  readonly body: unknown;
}

type Reply = MockReply | ((call: ApiCall) => MockReply | Promise<MockReply>);

/** `{ ok: true, data }` with status 200 (or `status`). */
export function ok(data: unknown, status = 200): MockReply {
  return { status, body: { ok: true, data } };
}

/** `{ ok: false, error: { code, message } }`. */
export function fail(status: number, code: string, message = code): MockReply {
  return { status, body: { ok: false, error: { code, message } } };
}

function matches(pattern: string, call: ApiCall): boolean {
  const [method, path] = pattern.split(' ');
  if (method !== call.method || path === undefined) return false;
  const regex = new RegExp(`^${path.replace(/[.?+^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '[^/?]+')}(\\?.*)?$`);
  return regex.test(call.path);
}

/**
 * Replaces `fetch` with a router over `METHOD /path` patterns (`*` matches one segment). A reply
 * list is consumed in order (its last entry repeats). Every call is recorded.
 */
export function mockApi(routes: Readonly<Record<string, Reply | readonly Reply[]>>) {
  const calls: ApiCall[] = [];
  const used = new Map<string, number>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: ApiCall = {
      method: init?.method ?? 'GET',
      path: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const pattern = Object.keys(routes).find((candidate) => matches(candidate, call));
    if (pattern === undefined) return Response.json({ ok: false, error: { code: 'NOT_FOUND', message: 'no mock' } }, { status: 404 });
    const configured = routes[pattern] as Reply | readonly Reply[];
    const list = Array.isArray(configured) ? (configured as readonly Reply[]) : [configured as Reply];
    const index = used.get(pattern) ?? 0;
    used.set(pattern, index + 1);
    const reply = list[Math.min(index, list.length - 1)] as Reply;
    const resolved = typeof reply === 'function' ? await reply(call) : reply;
    return Response.json(resolved.body, { status: resolved.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    callsTo: (method: string, prefix: string) => calls.filter((call) => call.method === method && call.path.startsWith(prefix)),
  };
}
