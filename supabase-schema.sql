-- Einmalig in Supabase ausfuehren: Projekt oeffnen -> "SQL Editor" -> "New query"
-- -> diesen Text einfuegen -> "Run".
create table if not exists app_state (
  id integer primary key,
  data jsonb not null
);
