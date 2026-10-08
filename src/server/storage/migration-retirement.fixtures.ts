import type { MigrationSource } from "./migration-source.ts";

import { readFileSync } from "node:fs";
import { defaultMigrationSource } from "./migration-source.ts";

/** Recreates the previously deployed schema for compatibility tests only. */
export const retiredUserMappingMigrationSource: MigrationSource = {
  readMigrations(dialect) {
    return [
      ...defaultMigrationSource.readMigrations(dialect),
      {
        name: "0018_user_connections.sql",
        sql: readFileSync(
          new URL(`../../../retired-migrations/${dialect}-0018_user_connections.sql`, import.meta.url),
          "utf8",
        ),
      },
    ];
  },
};
