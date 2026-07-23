-- Esquema del portal del tratante (KidneyChef). Correr una sola vez en el
-- SQL Editor de Supabase, después de crear el proyecto.
--
-- Toda la lógica de permisos vive en server.py, no en políticas de Supabase
-- (RLS queda encendido pero sin políticas permisivas, "default-deny") — el
-- backend habla con service_role, que bypasea RLS. Ver
-- ~/.claude/plans/spicy-knitting-thimble.md para el resto del diseño.

create table pacientes (
  id uuid primary key default gen_random_uuid(),
  codigo_cliente text unique not null,
  device_secret_hash text not null,
  metas_potasio_mg numeric,
  metas_fosforo_mg numeric,
  metas_actualizado_por uuid,
  metas_actualizado_at timestamptz,
  created_at timestamptz not null default now()
);

create table perfiles_tratante (
  id uuid primary key references auth.users (id) on delete cascade,
  nombre text not null,
  tipo text not null check (tipo in ('nefrologo', 'nutricionista')),
  created_at timestamptz not null default now()
);

create table vinculos (
  id uuid primary key default gen_random_uuid(),
  paciente_id uuid not null references pacientes (id) on delete cascade,
  tratante_id uuid not null references auth.users (id) on delete cascade,
  estado text not null check (estado in ('pendiente', 'activo', 'revocado', 'rechazado')),
  alias text,
  creado_at timestamptz not null default now(),
  confirmado_at timestamptz
);

-- Único parcial (no un unique() plano): permite que un vínculo revocado o
-- rechazado se vuelva a pedir más adelante, pero no dos pendientes/activos
-- a la vez entre el mismo par paciente-tratante.
create unique index vinculos_paciente_tratante_activo_idx
  on vinculos (paciente_id, tratante_id)
  where estado in ('pendiente', 'activo');

create index vinculos_tratante_estado_idx on vinculos (tratante_id, estado);
create index vinculos_paciente_estado_idx on vinculos (paciente_id, estado);

create table consumos_diarios (
  paciente_id uuid not null references pacientes (id) on delete cascade,
  fecha date not null,
  potasio_mg numeric,
  fosforo_mg numeric,
  actualizado_at timestamptz not null default now(),
  primary key (paciente_id, fecha)
);

alter table pacientes enable row level security;
alter table perfiles_tratante enable row level security;
alter table vinculos enable row level security;
alter table consumos_diarios enable row level security;
-- Sin políticas: todo acceso pasa por server.py con la key service_role
-- (bypasea RLS). Esto deja RLS solo como defensa en profundidad si la key
-- anon se filtrara alguna vez.
