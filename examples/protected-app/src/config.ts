import { readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { resolve } from 'node:path';

export interface Config {
  origin: string;
  port: number;
  host: string;
  development: boolean;
  dataDir: string;
  assetsDir: string;
  krineUrl: string;
  krineBrowserUrl: string;
  publicKey: string;
  secretKey: string;
  fallback: 'ALLOW' | 'DENY';
  trustedProxies: BlockList;
}

export function loadConfig(env = process.env): Config {
  const development = env.DEMO_DEVELOPMENT === 'true';
  if (env.DEMO_DEVELOPMENT !== undefined && !['true', 'false'].includes(env.DEMO_DEVELOPMENT)) {
    throw new Error('DEMO_DEVELOPMENT must be true or false.');
  }
  const origin = originUrl(env.DEMO_ORIGIN ?? 'http://localhost:3000', development);
  const krineUrl = originUrl(env.KRINE_URL ?? 'http://127.0.0.1:8080', development);
  const krineBrowserUrl = originUrl(env.KRINE_BROWSER_URL ?? krineUrl, development);
  const port = Number(env.DEMO_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DEMO_PORT.');
  const fallback = env.KRINE_FALLBACK ?? 'ALLOW';
  if (fallback !== 'ALLOW' && fallback !== 'DENY') throw new Error('Invalid KRINE_FALLBACK.');
  const host = env.DEMO_HOST ?? '127.0.0.1';
  if (!isIP(host)) throw new Error('DEMO_HOST must be a listen IP.');
  const trustedProxies = new BlockList();
  for (const cidr of (env.DEMO_TRUSTED_PROXIES ?? '').split(',').filter(Boolean)) {
    const [ip, bits, extra] = cidr.trim().split('/');
    const family = isIP(ip ?? '');
    if (!family || extra !== undefined || (bits !== undefined && !/^\d+$/.test(bits))) {
      throw new Error('Invalid DEMO_TRUSTED_PROXIES CIDR.');
    }
    const prefix = bits === undefined ? (family === 4 ? 32 : 128) : Number(bits);
    if (prefix < 1 || prefix > (family === 4 ? 32 : 128)) throw new Error('Invalid trusted proxy prefix.');
    trustedProxies.addSubnet(ip!, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return {
    origin, krineUrl, krineBrowserUrl, port, host, development, trustedProxies, fallback,
    dataDir: resolve(env.DEMO_DATA_DIR ?? '.data'), assetsDir: resolve('dist/public'),
    publicKey: secret(env, 'KRINE_PUBLIC_KEY'), secretKey: secret(env, 'KRINE_SECRET_KEY'),
  };
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  if (env[name] && env[`${name}_FILE`]) throw new Error(`Set only ${name} or ${name}_FILE.`);
  const value = env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, 'utf8').trim() : env[name];
  if (!value || !/^[\x21-\x7e]{24,4096}$/.test(value)) throw new Error(`Missing or invalid ${name}.`);
  return value;
}

function originUrl(raw: string, development: boolean): string {
  const url = new URL(raw);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(development && url.protocol === 'http:'))) {
    throw new Error('Use an HTTPS origin, or enable DEMO_DEVELOPMENT for local HTTP.');
  }
  return url.origin;
}
