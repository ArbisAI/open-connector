# Retired migrations

Migration `0018_user_connections.sql` added `users` and `user_connections` for
the removed `/v1/users/connectors` API. The SQLite and PostgreSQL SQL files are
preserved here as historical records and compatibility-test fixtures.

This directory is outside the active migration sources. New databases do not
create these two tables, and PostgreSQL startup no longer requires migration
`0018_user_connections.sql`.

Existing databases may retain both tables, their rows, and the `0018` entry in
`runtime_migrations`. Startup accepts these historical entries. This change does
not drop tables, erase migration history, or move existing connector credentials.

Do not apply these archived files to new databases or remove deployed tables as
part of startup. Any later table removal requires checking existing data and
dependencies and taking a recoverable backup first.
