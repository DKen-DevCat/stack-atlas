CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id     TEXT PRIMARY KEY,
  status VARCHAR(20) NOT NULL,
  note   TEXT
);
