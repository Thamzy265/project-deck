-- Makes the snapshot test fixtures with the system sqlite3 (3.54.0 on macOS 27, 2026-10-17):
--   cd packages/db-sqlite/src/testing/fixtures && rm -f wal-app.* plain.* && sqlite3 wal-app.sqlite < make-fixtures.sql
-- The copies are taken with .system while the connection is open, so the WAL file still
-- holds the commits, as the snapshot backend finds it on a device.
PRAGMA page_size = 1024;
PRAGMA journal_mode = WAL;
PRAGMA wal_autocheckpoint = 0;
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER);
CREATE TABLE lines (order_id INTEGER REFERENCES orders(id), n INTEGER, qty REAL, PRIMARY KEY (order_id, n));
CREATE TABLE raw (x);
CREATE INDEX orders_status ON orders(status);
CREATE VIEW pending AS SELECT id, item FROM orders WHERE status = 'pending';
INSERT INTO orders (item, status, created) VALUES ('Coffee', 'pending', 1760000000000), ('Tea', 'pending', 1760000001000);
INSERT INTO lines VALUES (1, 1, 2.5), (1, 2, 1.0);
INSERT INTO raw VALUES (x'00ff10'), (9007199254740993), (NULL), ('text');
PRAGMA wal_checkpoint(TRUNCATE);
-- These two commits stay in the WAL.
INSERT INTO orders (item, status, created) VALUES ('Cake', 'pending', 1760000002000);
UPDATE orders SET status = 'shipped' WHERE id = 1;
.system cp wal-app.sqlite snap.sqlite && cp wal-app.sqlite-wal snap.sqlite-wal
.system sqlite3 plain-src.sqlite "PRAGMA page_size=1024; CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT NOT NULL, status TEXT NOT NULL); INSERT INTO orders VALUES (1, 'Coffee', 'pending'), (2, 'Tea', 'pending');" && mv plain-src.sqlite plain.sqlite
