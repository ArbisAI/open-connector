create table users (
  id text primary key,
  created_at text not null
);

create table user_connections (
  id text primary key,
  user_id text not null references users (id),
  connection_service text not null,
  created_at text not null,
  updated_at text not null,
  unique (user_id, connection_service)
);

create index user_connections_user on user_connections (user_id);
