import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function openTestDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const sql = readFileSync(new URL("../../migrations/0003_access.sql", import.meta.url), "utf8");
  sqlite.exec(sql);
  const db = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      const bound = (params: unknown[]) => ({
        async run() {
          const info = statement.run(...(params as never[]));
          return { success: true, meta: { changes: info.changes ?? 0 } };
        },
        async first<T>() {
          const row = statement.get(...(params as never[]));
          return (row ?? null) as T | null;
        },
        async all<T>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
      });
      return { ...bound([]), bind(...params: unknown[]) { return bound(params); } };
    },
  } as D1Database;
  return { sqlite, db };
}
