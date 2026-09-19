-- Migración idempotente para un proyecto de Supabase que ya existe: suma la
-- foto del paciente y las indicaciones de exámenes de control.
-- Correr en el SQL Editor de Supabase ANTES de usar la versión nueva del
-- portal (el backend ya desplegado consultará estas tablas).
--
-- Las dos tablas son nuevas, así que no hay ALTER de columnas: basta con
-- `if not exists` para poder correr esto dos veces sin romper nada.

-- La foto va en su PROPIA tabla, no en una columna de `pacientes`: esa fila
-- se lee entera (`select=*`) en cada request autenticado del paciente, y
-- arrastrar ahí un base64 de decenas de KB encarecería todas las llamadas.
create table if not exists fotos_paciente (
  paciente_id uuid primary key references pacientes (id) on delete cascade,
  imagen_base64 text not null,
  mime text not null,
  -- Sin consentimiento no hay fila: el paciente marca la casilla en su app y
  -- server.py exige ese campo para guardar. Borrar la foto borra la fila.
  consentimiento_at timestamptz not null,
  actualizado_at timestamptz not null default now()
);

-- Indicación de exámenes de control. NO es una orden médica: no identifica
-- establecimiento ni lleva firma electrónica, y así se rotula en la app del
-- paciente y en el portal. Es un recado del tratante a su paciente.
create table if not exists indicaciones_examenes (
  id uuid primary key default gen_random_uuid(),
  paciente_id uuid not null references pacientes (id) on delete cascade,
  tratante_id uuid not null references auth.users (id) on delete cascade,
  -- Snapshot [{id, etiqueta}] del catálogo al momento de crearla: la
  -- indicación tiene que leerse igual dentro de un año aunque el catálogo
  -- cambie de nombres.
  examenes jsonb not null default '[]'::jsonb,
  otros text,
  nota text,
  fecha_sugerida date,
  estado text not null default 'vigente' check (estado in ('vigente', 'cancelada')),
  creada_at timestamptz not null default now(),
  vista_at timestamptz,
  hecha_at timestamptz
);

create index if not exists indicaciones_paciente_idx
  on indicaciones_examenes (paciente_id, creada_at desc);
create index if not exists indicaciones_tratante_idx
  on indicaciones_examenes (tratante_id, creada_at desc);

alter table fotos_paciente enable row level security;
alter table indicaciones_examenes enable row level security;
-- Sin políticas, igual que el resto del esquema: todo acceso pasa por
-- server.py con la key service_role.

grant select, insert, update, delete on fotos_paciente to service_role;
grant select, insert, update, delete on indicaciones_examenes to service_role;

-- Tercer tipo de tratante: el médico nutriólogo. NO es lo mismo que el
-- nutricionista — el nutriólogo es médico, el nutricionista es profesión de
-- colaboración médica. La diferencia importa porque solo los médicos pueden
-- indicar exámenes (ver TIPOS_MEDICOS en server.py).
alter table perfiles_tratante drop constraint if exists perfiles_tratante_tipo_check;
alter table perfiles_tratante add constraint perfiles_tratante_tipo_check
  check (tipo in ('nefrologo', 'nutriologo', 'nutricionista'));
