import { Database, type SQLQueryBindings } from "bun:sqlite";

const meta = (): D1Meta & Record<string, unknown> => ({
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: true,
  changes: 0
}) as D1Meta & Record<string, unknown>;

class BunD1PreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly database: Database,
    private readonly queryText: string,
    private readonly bindings: SQLQueryBindings[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new BunD1PreparedStatement(this.database, this.queryText, values as SQLQueryBindings[]);
  }

  execute<T = Record<string, unknown>>(): D1Result<T> {
    const results = this.database.query(this.queryText).all(...this.bindings) as T[];
    return { success: true, results, meta: meta() };
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const row = this.database.query(this.queryText).get(...this.bindings) as Record<string, unknown> | null;
    if (!row) return null;
    return (columnName ? row[columnName] : row) as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.database.query(this.queryText);
    const rows = statement.values(...this.bindings) as T[];
    return options?.columnNames ? [statement.columnNames as string[], ...rows] : rows;
  }
}

export class BunD1Database implements D1Database {
  readonly sqlite: Database;

  constructor(migrationSql: string) {
    this.sqlite = new Database(":memory:");
    this.sqlite.exec(migrationSql);
  }

  prepare(query: string): D1PreparedStatement {
    return new BunD1PreparedStatement(this.sqlite, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const execute = this.sqlite.transaction(() => statements.map((statement) =>
      (statement as BunD1PreparedStatement).execute<T>()
    ));
    return execute();
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.sqlite.exec(query);
    return { count: 0, duration: 0 };
  }

  withSession(): D1DatabaseSession {
    return {
      prepare: (query) => this.prepare(query),
      batch: (statements) => this.batch(statements),
      getBookmark: () => null
    };
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  close(): void {
    this.sqlite.close();
  }
}

export function interceptNextBatch(
  database: BunD1Database,
  before: () => void,
  after?: () => void
): D1Database {
  let pending = true;
  return {
    prepare: (query) => database.prepare(query),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      if (pending) {
        pending = false;
        before();
        const result = await database.batch<T>(statements);
        after?.();
        return result;
      }
      return database.batch<T>(statements);
    },
    exec: (query) => database.exec(query),
    withSession: () => database.withSession(),
    dump: () => database.dump()
  } as D1Database;
}
