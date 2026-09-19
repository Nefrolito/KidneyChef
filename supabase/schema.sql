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
  metas_sodio_mg numeric,
  metas_potasio_mg numeric,
  metas_fosforo_mg numeric,
  metas_carbohidratos_g numeric,
  metas_calorias_kcal numeric,
  metas_liquidos_ml numeric,
  metas_actualizado_por uuid,
  metas_actualizado_at timestamptz,
  created_at timestamptz not null default now()
);

create table perfiles_tratante (
  id uuid primary key references auth.users (id) on delete cascade,
  nombre text not null,
  -- 'nutriologo' es el MÉDICO nutriólogo, distinto del 'nutricionista'
  -- (profesión de colaboración médica). Solo los médicos indican exámenes.
  tipo text not null check (tipo in ('nefrologo', 'nutriologo', 'nutricionista')),
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

-- service_role bypasea RLS, pero igual necesita los privilegios de tabla
-- de Postgres — Supabase solo los otorga automáticamente a tablas nuevas si
-- los privilegios por defecto ya estaban configurados antes de crearlas.
-- Sin este bloque, el backend recibe "permission denied for table ...".
grant usage on schema public to service_role;
grant select, insert, update, delete on pacientes to service_role;
grant select, insert, update, delete on perfiles_tratante to service_role;
grant select, insert, update, delete on vinculos to service_role;
grant select, insert, update, delete on consumos_diarios to service_role;


-- --- Foto del paciente e indicaciones de exámenes (2026-09-19) -----------
-- Para un proyecto que ya existía, lo mismo está en
-- `migracion-2026-09-19-foto-indicaciones.sql` (con `if not exists`).

-- En tabla aparte y no como columna de `pacientes` porque esa fila se lee
-- entera (`select=*`) en cada request autenticado del paciente.
create table fotos_paciente (
  paciente_id uuid primary key references pacientes (id) on delete cascade,
  imagen_base64 text not null,
  mime text not null,
  consentimiento_at timestamptz not null,
  actualizado_at timestamptz not null default now()
);

-- Indicación de exámenes de control: un recado del tratante a su paciente,
-- NO una orden médica (sin establecimiento ni firma electrónica).
create table indicaciones_examenes (
  id uuid primary key default gen_random_uuid(),
  paciente_id uuid not null references pacientes (id) on delete cascade,
  tratante_id uuid not null references auth.users (id) on delete cascade,
  examenes jsonb not null default '[]'::jsonb,
  otros text,
  nota text,
  fecha_sugerida date,
  estado text not null default 'vigente' check (estado in ('vigente', 'cancelada')),
  creada_at timestamptz not null default now(),
  vista_at timestamptz,
  hecha_at timestamptz
);

create index indicaciones_paciente_idx on indicaciones_examenes (paciente_id, creada_at desc);
create index indicaciones_tratante_idx on indicaciones_examenes (tratante_id, creada_at desc);

alter table fotos_paciente enable row level security;
alter table indicaciones_examenes enable row level security;

grant select, insert, update, delete on fotos_paciente to service_role;
grant select, insert, update, delete on indicaciones_examenes to service_role;
