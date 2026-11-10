/** api-link の内部ヘルパ */
import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';
import type { Cache } from '@stack-atlas/schema';
import type { PartialNode } from '@stack-atlas/core';
import type { ApiCall } from './client.js';

export const toPosix = (p: string) => p.split(sep).join('/');

/** ts-imports の libName と同じ規則（apiClient.ts → apiClient） */
export function libName(relPath: string): string {
  let base = basename(relPath, extname(relPath));
  if (base === 'index') {
    const skip = new Set(['src', 'lib', 'app', 'dist', 'source']);
    const dirs = relPath.split('/').slice(0, -1).reverse();
    base = dirs.find((d) => d && !skip.has(d)) ?? 'index';
  }
  const parts = base.split(/[-_.\s]+/).filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join('') || base;
}

export function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export const ROUTE_KEY = /^(ANY|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/\S*$|^\$default$/;

export function routeComments(src: string): string[] {
  return [...src.matchAll(/@route\s+([A-Z]+ \/\S*|\$default)/g)]
    .map((m) => m[1]!)
    .filter((k) => ROUTE_KEY.test(k));
}

export function fetchCache(calls: ApiCall[]): Cache | undefined {
  const rules = calls
    .filter((c) => c.revalidate !== undefined || c.tags || c.cache)
    .map((c) => {
      const parts: string[] = [];
      if (c.cache) parts.push(c.cache);
      if (c.revalidate !== undefined)
        parts.push(c.revalidate === false ? 'revalidate false' : `revalidate ${c.revalidate}s`);
      if (c.tags && c.tags.length > 0) parts.push(`tags ${c.tags.join(', ')}`);
      return { key: `${c.method} ${c.path}`, value: parts.join(' / ') };
    });
  return rules.length > 0 ? { tone: 'info', badge: 'fetch cache', rules } : undefined;
}

/** infra ノードの Terraform 型（cdktf / terraform / cloudformation のどれでも） */
export function infraType(n: Pick<PartialNode, 'meta'>): string | undefined {
  for (const key of ['infra', 'cdktf']) {
    const v = n.meta?.[key] as { type?: unknown } | undefined;
    if (v && typeof v.type === 'string') return v.type;
  }
  return undefined;
}
