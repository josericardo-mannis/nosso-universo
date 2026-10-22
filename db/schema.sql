-- Um documento JSON por linha, agrupado por coleção (mesmo modelo do app).
CREATE TABLE IF NOT EXISTS docs (
  col        TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (col, id)
);
CREATE INDEX IF NOT EXISTS docs_updated ON docs (updated_at);
