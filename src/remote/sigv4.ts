/**
 * remote/sigv4.ts —— AWS Signature Version 4（需求 12.1：自己实现，不引 SDK）。
 *
 * 只覆盖 S3 单次请求签名（不做分块上传、不做预签名 URL），因为同步只需要
 * GET / PUT / DELETE / GET?list-type=2 四种请求。
 *
 * 签名过程对格式极度敏感 —— 规范请求串里少一个换行、查询参数没排序、
 * 路径没做双重编码，都会得到 403 SignatureDoesNotMatch 而没有任何提示。
 * 因此每一步都对照 AWS 文档写死，并用官方测试向量交叉验证。
 */

import { hmacSha256, hmacSha256Text, sha256HexBytes, toHex } from '../platform/crypto.js';

const utf8 = new TextEncoder();

export interface SigV4Request {
  method: string;
  /** 主机名（不含协议与端口）。 */
  host: string;
  /** 已编码的路径，以 / 开头。 */
  path: string;
  /** 查询参数，签名时会排序。 */
  query?: Record<string, string>;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

/**
 * URI 编码。AWS 的规则与 encodeURIComponent 不同：
 * 不转义 A-Za-z0-9-_.~，其余全部转义，且必须大写十六进制。
 */
export function uriEncode(value: string, encodeSlash: boolean): string {
  let out = '';
  for (const byte of utf8.encode(value)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      out += ch;
    } else if (ch === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** ISO8601 基本格式：20260730T100000Z。 */
export function amzDate(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

export function dateStamp(now: Date): string {
  return amzDate(now).slice(0, 8);
}

/** 规范查询串：按参数名排序，键值都编码。 */
function canonicalQuery(query: Record<string, string> | undefined): string {
  if (query === undefined) return '';
  return Object.keys(query)
    .sort()
    .map((key) => `${uriEncode(key, true)}=${uriEncode(query[key] ?? '', true)}`)
    .join('&');
}

interface CanonicalHeaders {
  canonical: string;
  signed: string;
}

/**
 * 规范请求头：名小写、值去首尾空白并压缩内部连续空格、按名排序。
 * 压缩空格这一步容易漏 —— 漏了在多空格的 header 上就会签名不匹配。
 */
function canonicalHeaders(headers: Record<string, string>): CanonicalHeaders {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  };
}

/** 派生签名密钥：AWS4 前缀 + 日期 → 区域 → 服务 → aws4_request 四级 HMAC。 */
export function signingKey(secret: string, stamp: string, region: string, service: string): Uint8Array {
  const kDate = hmacSha256Text(utf8.encode(`AWS4${secret}`), stamp);
  const kRegion = hmacSha256Text(kDate, region);
  const kService = hmacSha256Text(kRegion, service);
  return hmacSha256Text(kService, 'aws4_request');
}

export interface SignedRequest {
  headers: Record<string, string>;
  /** 便于测试与排错。 */
  canonicalRequest: string;
  stringToSign: string;
}

/**
 * 给请求签名，返回需要附加的请求头。
 *
 * 调用方必须把返回的 headers 全部带上 —— 少一个 x-amz-content-sha256
 * 就会被 S3 拒绝。
 */
export function signRequest(req: SigV4Request, creds: SigV4Credentials, now: Date): SignedRequest {
  const stamp = dateStamp(now);
  const timestamp = amzDate(now);
  const payloadHash = sha256HexBytes(req.body);

  const headers: Record<string, string> = {
    ...req.headers,
    host: req.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  };

  const { canonical, signed } = canonicalHeaders(headers);
  const canonicalRequest = [
    req.method.toUpperCase(),
    req.path,
    canonicalQuery(req.query),
    canonical,
    signed,
    payloadHash,
  ].join('\n');

  const scope = `${stamp}/${creds.region}/${creds.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    sha256HexBytes(utf8.encode(canonicalRequest)),
  ].join('\n');

  const signature = toHex(
    hmacSha256(signingKey(creds.secretAccessKey, stamp, creds.region, creds.service), utf8.encode(stringToSign)),
  );

  return {
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signed}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
  };
}
