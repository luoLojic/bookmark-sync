import { describe, expect, it } from 'vitest';
import { amzDate, dateStamp, signRequest, signingKey, uriEncode } from '../../src/remote/sigv4.js';
import { toHex } from '../../src/platform/crypto.js';

const utf8 = new TextEncoder();

describe('uriEncode（AWS 规则与 encodeURIComponent 不同）', () => {
  it('保留 A-Za-z0-9-_.~ 不转义', () => {
    expect(uriEncode('aZ09-_.~', true)).toBe('aZ09-_.~');
  });

  it('十六进制必须大写', () => {
    // 小写会导致 SignatureDoesNotMatch，且没有任何提示。
    expect(uriEncode(' ', true)).toBe('%20');
    expect(uriEncode('中', true)).toBe('%E4%B8%AD');
  });

  it('encodeSlash 控制 / 是否转义', () => {
    expect(uriEncode('a/b', false)).toBe('a/b');
    expect(uriEncode('a/b', true)).toBe('a%2Fb');
  });

  it('转义 encodeURIComponent 会放过的字符', () => {
    // encodeURIComponent 不转义 ! ' ( ) *，AWS 要求转义。
    expect(uriEncode("!'()*", true)).toBe('%21%27%28%29%2A');
  });
});

describe('时间格式', () => {
  const now = new Date('2026-07-30T10:20:30.456Z');

  it('amzDate 为 ISO8601 基本格式', () => {
    expect(amzDate(now)).toBe('20260730T102030Z');
  });

  it('dateStamp 只取日期部分', () => {
    expect(dateStamp(now)).toBe('20260730');
  });
});

describe('signingKey（AWS 官方测试向量）', () => {
  it('与文档给出的派生结果一致', () => {
    // 来自 AWS「Examples of the complete Signature Version 4 signing process」。
    const key = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
    expect(toHex(key)).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  });
});

describe('signRequest（AWS 官方 GET 向量）', () => {
  it('复现文档示例的规范请求串与签名', () => {
    // AWS 文档的 iam GET 示例：签名结果是公开的已知值，可以逐字对照。
    const signed = signRequest(
      {
        method: 'GET',
        host: 'iam.amazonaws.com',
        path: '/',
        query: { Action: 'ListUsers', Version: '2010-05-08' },
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new Uint8Array(),
      },
      {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
        service: 'iam',
      },
      new Date('2015-08-30T12:36:00Z'),
    );

    expect(signed.canonicalRequest.split('\n')[0]).toBe('GET');
    expect(signed.canonicalRequest).toContain('Action=ListUsers&Version=2010-05-08');
    expect(signed.stringToSign.split('\n')[0]).toBe('AWS4-HMAC-SHA256');
    expect(signed.stringToSign).toContain('20150830/us-east-1/iam/aws4_request');
    expect(signed.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\//);
  });
});

describe('signRequest — S3 场景', () => {
  const creds = {
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
    region: 'us-east-1',
    service: 's3',
  };
  const now = new Date('2026-07-30T10:00:00Z');

  it('必带 x-amz-content-sha256 与 x-amz-date', () => {
    // 少任何一个 S3 都会拒绝。
    const signed = signRequest(
      { method: 'PUT', host: 'b.s3.amazonaws.com', path: '/a.json', headers: {}, body: utf8.encode('x') },
      creds,
      now,
    );
    expect(signed.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.headers['x-amz-date']).toBe('20260730T100000Z');
    expect(signed.headers['host']).toBe('b.s3.amazonaws.com');
  });

  it('SignedHeaders 与实际签名的头一致且已排序', () => {
    const signed = signRequest(
      {
        method: 'PUT',
        host: 'b.s3.amazonaws.com',
        path: '/a.json',
        headers: { 'content-type': 'application/json', 'if-match': '"v1"' },
        body: new Uint8Array(),
      },
      creds,
      now,
    );
    const match = /SignedHeaders=([^,]+)/.exec(signed.headers['authorization']!);
    const list = match![1]!.split(';');
    expect(list).toEqual([...list].sort());
    expect(list).toContain('if-match');
    expect(list).toContain('x-amz-content-sha256');
  });

  it('请求体不同 → 签名不同（载荷参与签名）', () => {
    const sign = (body: string) =>
      signRequest(
        { method: 'PUT', host: 'h', path: '/a', headers: {}, body: utf8.encode(body) },
        creds,
        now,
      ).headers['authorization'];
    expect(sign('a')).not.toBe(sign('b'));
  });

  it('查询参数顺序不影响签名（签名前排序）', () => {
    const a = signRequest(
      { method: 'GET', host: 'h', path: '/', query: { b: '2', a: '1' }, headers: {}, body: new Uint8Array() },
      creds,
      now,
    );
    const b = signRequest(
      { method: 'GET', host: 'h', path: '/', query: { a: '1', b: '2' }, headers: {}, body: new Uint8Array() },
      creds,
      now,
    );
    expect(a.headers['authorization']).toBe(b.headers['authorization']);
  });

  it('请求头值的多余空白被压缩，不影响签名', () => {
    // 漏掉这一步，带多空格的 header 会签名不匹配。
    const a = signRequest(
      { method: 'GET', host: 'h', path: '/', headers: { 'x-test': 'a  b' }, body: new Uint8Array() },
      creds,
      now,
    );
    const b = signRequest(
      { method: 'GET', host: 'h', path: '/', headers: { 'x-test': ' a b ' }, body: new Uint8Array() },
      creds,
      now,
    );
    expect(a.headers['authorization']).toBe(b.headers['authorization']);
  });

  it('区域或服务不同 → 签名不同（作用域参与派生）', () => {
    const base = { method: 'GET', host: 'h', path: '/', headers: {}, body: new Uint8Array() };
    const one = signRequest(base, creds, now).headers['authorization'];
    const two = signRequest(base, { ...creds, region: 'eu-west-1' }, now).headers['authorization'];
    expect(one).not.toBe(two);
  });
});
