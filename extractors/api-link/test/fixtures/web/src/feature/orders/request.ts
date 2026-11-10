import { fetcher } from '@/lib/fetcher';
import { ORDERS_ENDPOINT } from './consts';

export const listOrders = (page: number) =>
  fetcher(`${ORDERS_ENDPOINT}?page=${encodeURIComponent(page)}`);

export const loadOrders = async (page: number) => listOrders(page);

export const createOrder = (body: string) => fetcher(ORDERS_ENDPOINT, { method: 'POST', body });

export const deleteOrder = (id: string) =>
  fetcher(`/orders/${encodeURIComponent(id)}/`, { method: 'DELETE' });
