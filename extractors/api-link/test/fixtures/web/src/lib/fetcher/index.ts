const API_DOMAIN = process.env.NEXT_PUBLIC_API_DOMAIN ?? '';

export const request = (url: string, init: RequestInit) => fetch(`${API_DOMAIN}${url}`, init);

export const fetcher = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await request(url, { ...init, headers: { accept: 'application/json' } });
  return (await res.json()) as T;
};
