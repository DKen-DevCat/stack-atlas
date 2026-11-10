const fullUrl = (endpoint: string) =>
  typeof window === 'undefined' ? `http://localhost:3000${endpoint}` : endpoint;

export function clientFetcher(endpoint: string, init: RequestInit = {}) {
  return fetch(fullUrl(endpoint), init);
}
