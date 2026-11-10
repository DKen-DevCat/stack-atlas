import { clientFetcher } from '@/lib/fetcher/client';

const API_DOMAIN = process.env.NEXT_PUBLIC_API_DOMAIN;
const labels = new Map<string, string>();

export async function ping(key: string) {
  labels.get(key);
  (1234).toLocaleString('ja-JP');
  await clientFetcher('/unknown');
  return fetch(`${API_DOMAIN}/ping`, { method: 'POST' });
}

export default function PingIsland() {
  return <button onClick={() => ping('x')}>ping</button>;
}
