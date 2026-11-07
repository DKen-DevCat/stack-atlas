package store

const insertItem = `INSERT INTO order_items (order_id, sku, qty) VALUES ($1, $2, $3)`
