import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonError, jsonOk } from './envelope';
import { ApiFailure, ConfigError } from './errors';
import { assertSameOrigin } from './origin';
import { clientIp, MAX_JSON_BODY_BYTES, readCookie, readJsonBody } from './request';
import { apiRoute } from './route';

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://app.test/api/x', { method: 'POST', body, headers });
}

describe('envelope', () => {
  it('wraps data as { ok: true, data } and never caches', async () => {
    const response = jsonOk({ a: 1 }, { status: 201, headers: { 'X-Test': 'yes' } });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-test')).toBe('yes');
    expect(await response.json()).toEqual({ ok: true, data: { a: 1 } });
  });

  it('maps error codes to HTTP statuses', async () => {
    const response = jsonError('RATE_LIMITED', 'Slow down', { 'Retry-After': '9' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('9');
    expect(await response.json()).toEqual({ ok: false, error: { code: 'RATE_LIMITED', message: 'Slow down' } });
  });
});

describe('clientIp', () => {
  it('uses the first forwarded hop, then X-Real-IP, then a shared bucket', () => {
    const forwarded = new Request('https://x', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
    expect(clientIp(forwarded)).toBe('203.0.113.9');
    expect(clientIp(new Request('https://x', { headers: { 'x-real-ip': '2001:db8::1' } }))).toBe('2001:db8::1');
    expect(clientIp(new Request('https://x', { headers: { 'x-forwarded-for': '<script>' } }))).toBe('unknown');
    expect(clientIp(new Request('https://x'))).toBe('unknown');
  });
});

describe('readJsonBody', () => {
  const Schema = z.strictObject({ name: z.string() });

  it('parses valid JSON bodies', async () => {
    await expect(readJsonBody(post('{"name":"ana"}', { 'content-type': 'application/json' }), Schema)).resolves.toEqual({
      name: 'ana',
    });
  });

  it('treats an empty body as {}', async () => {
    await expect(readJsonBody(post(''), z.strictObject({}))).resolves.toEqual({});
  });

  it.each([
    ['malformed JSON', post('{', { 'content-type': 'application/json' }), 'BAD_REQUEST'],
    ['a form body', post('name=ana', { 'content-type': 'application/x-www-form-urlencoded' }), 'BAD_REQUEST'],
    ['a schema mismatch', post('{"name":1}', { 'content-type': 'application/json' }), 'VALIDATION_FAILED'],
    ['an oversized body', post(`{"name":"${'a'.repeat(MAX_JSON_BODY_BYTES)}"}`, { 'content-type': 'application/json' }), 'BAD_REQUEST'],
    ['a lying content-length', post('{}', { 'content-type': 'application/json', 'content-length': '999999' }), 'BAD_REQUEST'],
  ])('rejects %s', async (_label, request, code) => {
    await expect(readJsonBody(request, Schema)).rejects.toMatchObject({ code });
  });
});

describe('readCookie', () => {
  it('finds one cookie among several', () => {
    const request = new Request('https://x', { headers: { cookie: 'a=1; vw_session=tok.en=; broken; b=2' } });
    expect(readCookie(request, 'vw_session')).toBe('tok.en=');
    expect(readCookie(request, 'missing')).toBeNull();
    expect(readCookie(new Request('https://x'), 'a')).toBeNull();
  });
});

describe('assertSameOrigin', () => {
  it('accepts only the app origin', () => {
    const ok = new Request('https://app.test/api', { method: 'POST', headers: { origin: 'https://app.test' } });
    expect(() => assertSameOrigin(ok, 'https://app.test')).not.toThrow();
    const evil = new Request('https://app.test/api', { method: 'POST', headers: { origin: 'https://app.test.evil' } });
    expect(() => assertSameOrigin(evil, 'https://app.test')).toThrow(ApiFailure);
    expect(() => assertSameOrigin(new Request('https://app.test/api', { method: 'POST' }), 'https://app.test')).toThrow(
      /must come from the VeriWork app/,
    );
  });
});

describe('apiRoute', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns expected failures into their envelope', async () => {
    const route = apiRoute('t', async () => {
      throw new ApiFailure('FORBIDDEN', 'Nope', { 'X-Why': 'test' });
    });
    const response = await route(new Request('https://x'));
    expect(response.status).toBe(403);
    expect(response.headers.get('x-why')).toBe('test');
  });

  it('hides configuration and unexpected errors behind generic messages and logs them', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const config = await apiRoute('t', async () => {
      throw new ConfigError('SESSION_SECRET is not set');
    })(new Request('https://x'));
    expect(config.status).toBe(500);
    expect(JSON.stringify(await config.json())).not.toContain('SESSION_SECRET');

    const crash = await apiRoute('t', async () => {
      throw 'boom';
    })(new Request('https://x'));
    expect(await crash.json()).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
    });
    const logged = write.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(logged.map((line) => line.event)).toEqual(['config_error', 'unhandled_error']);
    expect(logged[1]).toMatchObject({ name: 'NonError', message: 'boom', route: 't', level: 'error' });
  });
});
