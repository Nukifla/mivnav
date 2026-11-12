# SPDX-License-Identifier: GPL-2.0-only
"""The shared search index: one SQLite database every ingest source bakes
searchable records into, so search is one query surface instead of one
per source. See docs/architecture/search-index-schema.md for the schema,
the FTS5/R-Tree compile-time dependency, and the migration/staleness
details.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    region TEXT NOT NULL,
    category TEXT,
    title TEXT,
    text TEXT,
    lat REAL,
    lon REAL,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS records_source_region ON records(source, region);
CREATE INDEX IF NOT EXISTS records_category ON records(category);

-- rowid-joined: neither virtual table can key on `id` (TEXT); see
-- docs/architecture/search-index-schema.md.
CREATE VIRTUAL TABLE IF NOT EXISTS records_rtree USING rtree(
    id, min_lon, max_lon, min_lat, max_lat
);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(title, text, category);
"""


def _fts_query(raw: str) -> str:
    """Turn free text into a safe FTS5 MATCH: every term is quoted as a
    literal and ANDed, so caller input is always data, never FTS5 syntax.
    The last term gets a trailing `*` for prefix-match while typing."""
    terms = raw.split()
    if not terms:
        return '""'
    quoted = ['"' + t.replace('"', '""') + '"' for t in terms]
    quoted[-1] += "*"
    return " ".join(quoted)


@dataclass(frozen=True)
class SearchRecord:
    """One row a source bakes into the index. `id` need only be unique
    WITHIN one source's (source, region) batch — `rebake` qualifies it
    with source/region internally."""

    id: str
    category: str | None
    title: str | None
    text: str | None
    lat: float | None
    lon: float | None
    data: dict = field(default_factory=dict)


class SearchIndex:
    """A connection to the shared search database plus its query methods.

    One instance per process; a lock serializes writes since SQLite allows
    only one writer, while WAL lets reads proceed without blocking on a bake.
    """

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Kept, not just consumed here: dataset_layout.search_index_share
        # needs the on-disk file to stat it (see that function's docstring).
        self.path = path
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._lock = threading.Lock()
        with self._lock, self._conn:
            self._conn.executescript(_SCHEMA)
            self._migrate_fts_category()

    def _migrate_fts_category(self) -> None:
        """Rebuild `records_fts` if it predates the `category` column —
        see docs/architecture/search-index-schema.md."""
        try:
            self._conn.execute("SELECT category FROM records_fts LIMIT 1")
        except sqlite3.OperationalError:
            self._conn.execute("DROP TABLE records_fts")
            self._conn.execute("CREATE VIRTUAL TABLE records_fts USING fts5(title, text, category)")
            self._conn.execute(
                "INSERT INTO records_fts(rowid, title, text, category) "
                "SELECT rowid, title, text, category FROM records"
            )

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def rebake(
        self,
        source: str,
        region: str,
        records: Iterable[SearchRecord],
        updated_at: float,
    ) -> int:
        """Atomically replace every row of `(source, region)` with
        `records` — one transaction, so a reader never sees a half-written
        region and a dropped-upstream record leaves no orphan row."""
        rows = list(records)
        with self._lock, self._conn:
            old_rowids = [
                r[0]
                for r in self._conn.execute(
                    "SELECT rowid FROM records WHERE source = ? AND region = ?",
                    (source, region),
                )
            ]
            if old_rowids:
                placeholders = ",".join("?" * len(old_rowids))
                self._conn.execute(
                    f"DELETE FROM records_fts WHERE rowid IN ({placeholders})",
                    old_rowids,
                )
                self._conn.execute(
                    f"DELETE FROM records_rtree WHERE id IN ({placeholders})",
                    old_rowids,
                )
                self._conn.execute(
                    "DELETE FROM records WHERE source = ? AND region = ?",
                    (source, region),
                )
            for rec in rows:
                full_id = f"{source}:{region}:{rec.id}"
                cur = self._conn.execute(
                    "INSERT INTO records"
                    " (id, source, region, category, title, text, lat, lon, data, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        full_id,
                        source,
                        region,
                        rec.category,
                        rec.title,
                        rec.text,
                        rec.lat,
                        rec.lon,
                        json.dumps(rec.data),
                        updated_at,
                    ),
                )
                rowid = cur.lastrowid
                self._conn.execute(
                    "INSERT INTO records_fts(rowid, title, text, category) VALUES (?, ?, ?, ?)",
                    (rowid, rec.title or "", rec.text or "", rec.category or ""),
                )
                if rec.lat is not None and rec.lon is not None:
                    self._conn.execute(
                        "INSERT INTO records_rtree"
                        " (id, min_lon, max_lon, min_lat, max_lat)"
                        " VALUES (?, ?, ?, ?, ?)",
                        (rowid, rec.lon, rec.lon, rec.lat, rec.lat),
                    )
        return len(rows)

    def record_count(self, source: str | None = None, region: str | None = None) -> int:
        """Row count, optionally scoped. Used to attribute the shared
        db's on-disk bytes back to individual datasets by row share
        (dataset_layout.search_index_share) — skips FTS/rtree."""
        sql = "SELECT COUNT(*) FROM records"
        where: list[str] = []
        params: list[str] = []
        if source is not None:
            where.append("source = ?")
            params.append(source)
        if region is not None:
            where.append("region = ?")
            params.append(region)
        if where:
            sql += " WHERE " + " AND ".join(where)
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
        return int(row[0])

    def regions(self, source: str) -> list[str]:
        """Every region holding at least one row of ``source`` — so a source
        whose slices follow a changing set (notices: one per dataset) can
        empty the ones that are gone."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT DISTINCT region FROM records WHERE source = ?", (source,)
            ).fetchall()
        return [r[0] for r in rows]

    def record_ids(self, source: str, region: str) -> list[str]:
        """The caller's own ``SearchRecord.id`` of every row in
        ``(source, region)`` — the ``source:region:`` qualifier ``rebake``
        adds is stripped. Rides the ``(source, region)`` index; lets a live
        layer learn which refs a baked set already draws."""
        prefix = f"{source}:{region}:"
        with self._lock:
            rows = self._conn.execute(
                "SELECT id FROM records WHERE source = ? AND region = ?", (source, region)
            ).fetchall()
        return [r[0][len(prefix):] for r in rows if r[0].startswith(prefix)]

    def slice_updated_at(self, source: str, region: str) -> float | None:
        """The `updated_at` `rebake` last wrote for `(source, region)`, or
        `None` if empty — doubles as a staleness key against an on-disk
        source artifact (docs/architecture/search-index-schema.md)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT MAX(updated_at) FROM records WHERE source = ? AND region = ?",
                (source, region),
            ).fetchone()
        return None if row is None or row[0] is None else float(row[0])

    def search(
        self,
        query: str | None = None,
        *,
        source: str | None = None,
        category: str | None = None,
        bbox: Sequence[float] | None = None,
        limit: int = 50,
    ) -> list[dict]:
        """Records matching every filter (AND), newest-first. `bbox` is
        `(min_lon, min_lat, max_lon, max_lat)`; `query` goes through
        `_fts_query` so it is always data, never FTS5 syntax."""
        joins = ["records r"]
        where: list[str] = []
        params: list[object] = []
        if query:
            joins.append("JOIN records_fts f ON f.rowid = r.rowid")
            where.append("records_fts MATCH ?")
            params.append(_fts_query(query))
        if bbox is not None:
            min_lon, min_lat, max_lon, max_lat = bbox
            joins.append("JOIN records_rtree rt ON rt.id = r.rowid")
            where.append(
                "rt.min_lon <= ? AND rt.max_lon >= ? AND rt.min_lat <= ? AND rt.max_lat >= ?"
            )
            params.extend([max_lon, min_lon, max_lat, min_lat])
        if source is not None:
            where.append("r.source = ?")
            params.append(source)
        if category is not None:
            where.append("r.category = ?")
            params.append(category)
        sql = f"SELECT r.* FROM {' '.join(joins)}"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY r.rowid DESC LIMIT ?"
        params.append(limit)
        with self._lock:
            cur = self._conn.execute(sql, params)
            cols = [c[0] for c in cur.description]
            rows = [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]
        for row in rows:
            row["data"] = json.loads(row["data"])
        return rows
