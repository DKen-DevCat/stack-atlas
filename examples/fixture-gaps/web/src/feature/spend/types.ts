export type Entry = {
  id: string;
  merchant: string;
  amount: number;
};

export type Today = {
  total: number;
  entries: Entry[];
};

export type TodayView = {
  totalLabel: string;
  rows: Entry[];
};
