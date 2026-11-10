-- 初期スキーマ
CREATE TABLE IF NOT EXISTS public.orders (
  id         UUID PRIMARY KEY,
  total      INTEGER NOT NULL CHECK (total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_total_positive CHECK (total > 0)
);

CREATE TABLE "order_items" (
  order_id UUID NOT NULL REFERENCES orders (id),
  sku      TEXT NOT NULL,
  qty      INTEGER NOT NULL,
  PRIMARY KEY (order_id, sku)
);
