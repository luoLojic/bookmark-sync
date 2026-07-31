/**
 * remote/s3.ts —— S3 兼容对象存储 transport（方案 9.1）。
 *
 * 目标服务商：AWS S3 与 MinIO（方案 9.1 的决定）。其他 S3 兼容服务允许填写，
 * 但设置页标注「未验证」，能否条件写由 probe() 决定。
 *
 * 与 WebDAV 的三处差异：
 *   · 没有目录概念，ensureContainer 是空操作；
 *   · 列举用 ListObjectsV2（GET ?list-type=2）而不是 PROPFIND；
 *   · 条件写用 If-Match，但 S3 直到 2024 年才支持，不少兼容服务仍然忽略它 ——
 *     这正是 FR-18 降级模式存在的理由，probe() 会探明。
 */

import { normalizePrefix } from '../shared/config.js';
import { MisconfiguredError } from '../shared/errors.js';
import { isBodylessMethod, request } from '../platform/http.js';
import { signRequest, uriEncode } from './sigv4.js';
import { assertOk, type GetResult, type PutOptions, type PutResult, type RemoteStore } from './store.js';
import type { RemoteHttpDeps } from './webdav.js';
import type { S3Config } from '../shared/types.js';

export interface S3Deps extends RemoteHttpDeps {
  /** 注入时间，签名需要；也让测试可重放。 */
  now?: () => Date;
}

interface Target {
  url: string;
  host: string;
  /** 签名用的规范路径（逐段编码，不转义分隔用的 /）。 */
  canonicalPath: string;
}

/** 空载荷。SigV4 要对它算哈希，但不能把它交给 fetch（见 send 的注释）。 */
const EMPTY_PAYLOAD = new Uint8Array();

export function createS3Store(config: S3Config, deps: S3Deps): RemoteStore {
  const endpoint = config.endpoint.trim();
  if (endpoint === '') throw new MisconfiguredError('S3 Endpoint 未配置');
  if (!/^https?:\/\//i.test(endpoint)) throw new MisconfiguredError('S3 Endpoint 必须以 http:// 或 https:// 开头');
  if (config.bucket.trim() === '') throw new MisconfiguredError('S3 Bucket 未配置');
  if (config.accessKeyId.trim() === '' || config.secretAccessKey === '') {
    throw new MisconfiguredError('S3 凭据未配置');
  }

  const base = new URL(endpoint);
  const prefix = normalizePrefix(config.prefix);
  const now = deps.now ?? ((): Date => new Date());

  const creds = {
    accessKeyId: config.accessKeyId.trim(),
    secretAccessKey: config.secretAccessKey,
    region: config.region.trim() || 'us-east-1',
    service: 's3',
  };

  /** 对象键 → 请求目标。路径风格与虚拟主机风格的差别只在 host 与路径前缀。 */
  const targetFor = (key: string, query?: Record<string, string>): Target => {
    const fullKey = `${prefix}${key}`;
    const encodedKey = fullKey
      .split('/')
      .map((s) => uriEncode(s, true))
      .join('/');

    let host: string;
    let canonicalPath: string;
    if (config.forcePathStyle) {
      host = base.host;
      canonicalPath = `${base.pathname.replace(/\/+$/, '')}/${uriEncode(config.bucket, true)}/${encodedKey}`;
    } else {
      host = `${config.bucket}.${base.host}`;
      canonicalPath = `${base.pathname.replace(/\/+$/, '')}/${encodedKey}`;
    }
    if (!canonicalPath.startsWith('/')) canonicalPath = `/${canonicalPath}`;

    const search =
      query === undefined
        ? ''
        : `?${Object.keys(query)
            .sort()
            .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k] ?? '', true)}`)
            .join('&')}`;

    return { url: `${base.protocol}//${host}${canonicalPath}${search}`, host, canonicalPath };
  };

  /**
   * body 分两条路走，这是本文件最容易踩错的地方：
   *
   * SigV4 必须对**空载荷**算 SHA-256（GET / DELETE / list 的
   * `x-amz-content-sha256` 是空串的哈希），所以签名一侧永远要拿到一个
   * `Uint8Array`；但 GET / HEAD 一侧绝不能把它交给 fetch —— Fetch 规范判定
   * 的是 `init.body` 字段在不在，零长 ArrayBuffer 也会抛 TypeError。
   *
   * 因此：签名用 `payload`，发送用 `hasEntity` 决定是否传。
   */
  const send = async (
    method: string,
    key: string,
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {},
    query?: Record<string, string>,
  ) => {
    const payload = body ?? EMPTY_PAYLOAD;
    const target = targetFor(key, query);
    const signed = signRequest(
      {
        method,
        host: target.host,
        path: target.canonicalPath,
        ...(query === undefined ? {} : { query }),
        headers: extraHeaders,
        body: payload,
      },
      creds,
      now(),
    );
    // host 由 fetch 自己填，显式带上会被浏览器拒绝（forbidden header），
    // 但它必须参与签名，所以只在发送前摘掉。
    const sendHeaders = { ...signed.headers };
    delete sendHeaders['host'];

    const hasEntity = !isBodylessMethod(method) && payload.length > 0;
    return request(
      { method, url: target.url, headers: sendHeaders, ...(hasEntity ? { body: payload } : {}) },
      deps,
    );
  };

  return {
    async get(path: string): Promise<GetResult | null> {
      const res = await send('GET', path);
      if (res.status === 404) return null;
      assertOk(res, { method: 'GET', path });
      const etag = res.headers.get('etag');
      return etag === null ? { bytes: res.bytes } : { bytes: res.bytes, etag };
    },

    async put(path: string, bytes: Uint8Array, opts?: PutOptions): Promise<PutResult> {
      const headers: Record<string, string> = {
        'content-type': opts?.contentType ?? 'application/json',
      };
      if (opts?.ifMatch !== undefined) headers['if-match'] = opts.ifMatch;

      const res = await send('PUT', path, bytes, headers);
      // 部分兼容服务用 409 表达前置条件失败，统一交给 assertOk 归类为冲突。
      if (res.status === 409) assertOk({ ...res, status: 412 }, { method: 'PUT', path });
      assertOk(res, { method: 'PUT', path });
      const etag = res.headers.get('etag');
      return etag === null ? {} : { etag };
    },

    async remove(path: string): Promise<void> {
      const res = await send('DELETE', path);
      // S3 的 DELETE 本身幂等，不存在也返回 204。
      if (res.status === 404) return;
      assertOk(res, { method: 'DELETE', path });
    },

    async ensureContainer(): Promise<void> {
      // 对象存储没有目录，键里的 / 只是名字的一部分。
    },

    async list(prefixPath: string): Promise<string[]> {
      const listPrefix = `${prefix}${prefixPath.replace(/\/*$/, '')}/`;
      const names: string[] = [];
      let token: string | undefined;

      // ListObjectsV2 一次最多 1000 个，历史文件可能上千，必须翻页。
      do {
        const query: Record<string, string> = { 'list-type': '2', prefix: listPrefix };
        if (token !== undefined) query['continuation-token'] = token;

        const res = await send('GET', '', undefined, {}, query);
        if (res.status === 404) return [];
        assertOk(res, { method: 'GET', path: listPrefix });

        const xml = new TextDecoder().decode(res.bytes);
        for (const key of parseListKeys(xml)) {
          const name = key.slice(listPrefix.length);
          if (name !== '' && !name.includes('/')) names.push(name);
        }
        token = parseNextToken(xml);
      } while (token !== undefined);

      return names;
    },
  };
}

/** 从 ListObjectsV2 响应里取出 <Key>。手写解析，理由同 webdav.ts。 */
export function parseListKeys(xml: string): string[] {
  const out: string[] = [];
  const re = /<Key>([\s\S]*?)<\/Key>/gi;
  for (const match of xml.matchAll(re)) {
    const key = (match[1] ?? '').trim();
    if (key !== '') out.push(decodeXmlEntities(key));
  }
  return out;
}

export function parseNextToken(xml: string): string | undefined {
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  if (!truncated) return undefined;
  const match = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/i.exec(xml);
  const token = match?.[1]?.trim();
  return token === undefined || token === '' ? undefined : decodeXmlEntities(token);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
