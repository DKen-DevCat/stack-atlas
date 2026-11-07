CREATE TABLE transactions (
  id          TEXT PRIMARY KEY,
  merchant    TEXT NOT NULL,
  amount      BIGINT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inboxes (
  id         TEXT PRIMARY KEY,
  history_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
