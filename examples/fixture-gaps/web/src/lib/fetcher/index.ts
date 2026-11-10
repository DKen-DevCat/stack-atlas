import { API_DOMAIN } from './consts';

export async function fetcher<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_DOMAIN}${url}`, init);
  if (!res.ok) {
    throw new Error(`request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}
