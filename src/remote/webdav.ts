/**
 * remote/webdav.ts —— WebDAV transport（需求 5.1 / 方案 5.1）。
 *
 * 只用四个方法：GET / PUT / DELETE / MKCOL，加一个仅供「刷新索引」的 PROPFIND。
 * 正常同步路径不碰 PROPFIND —— FR-15 明确要求历史列表走 index.json，
 * 这样历史文件积累到几千个也不影响任何操作的速度。
 */

import { normalizeBasePath } from '../shared/config.js';
import { MisconfiguredError } from '../shared/errors.js';
import { request, type HttpDeps } from '../platform/http.js';
import { assertOk, type GetResult, type PutOptions, type PutResult, type RemoteStore } from './store.js';
import type { WebdavConfig } from '../shared/types.js';

export type RemoteHttpDeps = Omit<HttpDeps, 'signal'> & { signal?: AbortSignal };

/** UTF-8 安全的 Basic 认证头。btoa 不接受非 ASCII，密码含中文时会直接抛错。 */
function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/**
 * 拼接 URL。逐段编码，避免标题或路径里的空格与中文破坏请求行；
 * 已编码的段不重复编码（encodeURIComponent 会把 %2F 变成 %252F）。
 */
function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const segments = path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (/%[0-9a-fA-F]{2}/.test(s) ? s : encodeURIComponent(s)));
  return `${trimmedBase}/${segments.join('/')}`;
}

export function createWebdavStore(config: WebdavConfig, deps: RemoteHttpDeps): RemoteStore {
  const root = config.url.trim();
  if (root === '') throw new MisconfiguredError('WebDAV 地址未配置');
  if (!/^https?:\/\//i.test(root)) throw new MisconfiguredError('WebDAV 地址必须以 http:// 或 https:// 开头');

  const basePath = normalizeBasePath(config.basePath);
  const baseUrl = joinUrl(root, basePath);

  const headers = (extra?: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = { ...extra };
    // 允许匿名 WebDAV：用户名密码都空时不发 Authorization。
    if (config.username !== '' || config.password !== '') {
      out['authorization'] = basicAuth(config.username, config.password);
    }
    return out;
  };

  const urlFor = (path: string): string => joinUrl(baseUrl, path);

  return {
    async get(path: string): Promise<GetResult | null> {
      const res = await request({ method: 'GET', url: urlFor(path), headers: headers() }, deps);
      // 404 不是错误：首次同步时远端本来就没有 bookmarks.json。
      if (res.status === 404 || res.status === 410) return null;
      assertOk(res, { method: 'GET', path });
      const etag = res.headers.get('etag');
      return etag === null ? { bytes: res.bytes } : { bytes: res.bytes, etag };
    },

    async put(path: string, bytes: Uint8Array, opts?: PutOptions): Promise<PutResult> {
      const extra: Record<string, string> = {
        'content-type': opts?.contentType ?? 'application/json',
      };
      if (opts?.ifMatch !== undefined) extra['if-match'] = opts.ifMatch;

      const res = await request(
        { method: 'PUT', url: urlFor(path), headers: headers(extra), body: bytes },
        deps,
      );
      assertOk(res, { method: 'PUT', path });

      // 很多服务器 PUT 不回 ETag。此时不额外发 HEAD 去要 —— 弱网下多一轮往返
      // 的代价高于收益，engine 在下一次 GET 时自然会拿到（降级模式则靠 nonce）。
      const etag = res.headers.get('etag');
      return etag === null ? {} : { etag };
    },

    async remove(path: string): Promise<void> {
      const res = await request({ method: 'DELETE', url: urlFor(path), headers: headers() }, deps);
      // 已经不在了就算删成功，幂等。
      if (res.status === 404 || res.status === 410) return;
      assertOk(res, { method: 'DELETE', path });
    },

    async ensureContainer(): Promise<void> {
      // 逐级 MKCOL：多数服务器不会自动建父目录，而 PUT 到不存在的目录会 409。
      const segments = basePath.split('/').filter((s) => s !== '');
      let prefix = root.replace(/\/+$/, '');
      for (const segment of [...segments, 'history']) {
        prefix = joinUrl(prefix, segment);
        const res = await request({ method: 'MKCOL', url: prefix, headers: headers() }, deps);
        // 405 / 301 / 409 都可能表示「已存在」，各服务器不一致；
        // 真正的权限或路径问题会在随后的 PUT 上暴露，那里的报错更具体。
        if (res.status === 405 || res.status === 301 || res.status === 409) continue;
        if (res.status === 401 || res.status === 403) assertOk(res, { method: 'MKCOL', path: segment });
      }
    },

    async list(prefix: string): Promise<string[]> {
      const body =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>';
      const res = await request(
        {
          method: 'PROPFIND',
          url: urlFor(prefix),
          headers: headers({ depth: '1', 'content-type': 'application/xml; charset=utf-8' }),
          body,
        },
        deps,
      );
      if (res.status === 404) return [];
      assertOk(res, { method: 'PROPFIND', path: prefix });
      return parsePropfindNames(new TextDecoder().decode(res.bytes));
    },
  };
}

/**
 * 从 PROPFIND 响应里取出文件名。
 *
 * 手写而不引入 XML 解析器：只需要 href 里的最后一段，而 DOMParser 在
 * service worker 里不可用，引入解析库又与「零运行时依赖」冲突。
 */
export function parsePropfindNames(xml: string): string[] {
  const names: string[] = [];
  const re = /<(?:[a-zA-Z0-9]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?href>/gi;
  for (const match of xml.matchAll(re)) {
    const href = (match[1] ?? '').trim();
    if (href === '') continue;
    // 目录本身以 / 结尾，跳过。
    if (href.endsWith('/')) continue;
    const last = href.split('/').filter((s) => s !== '').pop();
    if (last === undefined) continue;
    try {
      names.push(decodeURIComponent(last));
    } catch {
      names.push(last);
    }
  }
  return names;
}
