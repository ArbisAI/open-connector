import type { RuntimeRow } from "../storage/runtime-sql.ts";

export interface UserConnectionMapping {
  id: string;
  userId: string;
  connectionService: string;
  createdAt: string;
  updatedAt: string;
}

export interface SqlStatement {
  sql: string;
  values: (string | number | null)[];
}

/** Executes all statements atomically; each result contains its RETURNING/SELECT rows. */
export type SqlTransaction = (statements: SqlStatement[]) => Promise<RuntimeRow[][]>;

/** Shared SQL lifecycle for SQLite, PostgreSQL and D1, using the same `?`-placeholder convention as the other stores. */
export class UserConnectionStore {
  private readonly transaction: SqlTransaction;

  constructor(transaction: SqlTransaction) {
    this.transaction = transaction;
  }

  async listByUser(userId: string): Promise<UserConnectionMapping[]> {
    const [rows] = await this.transaction([
      {
        sql: "select id, user_id, connection_service, created_at, updated_at from user_connections where user_id = ? order by connection_service",
        values: [userId],
      },
    ]);
    return rows.map(readUserConnectionRow);
  }

  async find(id: string): Promise<UserConnectionMapping | undefined> {
    const [rows] = await this.transaction([
      {
        sql: "select id, user_id, connection_service, created_at, updated_at from user_connections where id = ?",
        values: [id],
      },
    ]);
    return rows[0] ? readUserConnectionRow(rows[0]) : undefined;
  }

  async upsert(userId: string, connectionService: string): Promise<UserConnectionMapping> {
    const now = new Date().toISOString();
    const [, [row]] = await this.transaction([
      {
        sql: "insert into users (id, created_at) values (?, ?) on conflict (id) do nothing",
        values: [userId, now],
      },
      {
        sql: `insert into user_connections (id, user_id, connection_service, created_at, updated_at)
          values (?, ?, ?, ?, ?)
          on conflict (user_id, connection_service) do update set updated_at = excluded.updated_at
          returning id, user_id, connection_service, created_at, updated_at`,
        values: [crypto.randomUUID(), userId, connectionService, now, now],
      },
    ]);
    return readUserConnectionRow(row);
  }

  async delete(id: string): Promise<void> {
    await this.transaction([
      {
        sql: "delete from user_connections where id = ?",
        values: [id],
      },
    ]);
  }
}

function readUserConnectionRow(row: RuntimeRow): UserConnectionMapping {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    connectionService: row.connection_service as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
