-- Metas nuevas que puede fijar el tratante (2026-09-17).
--
-- Hasta ahora solo podía fijar potasio y fósforo. Tras el rechazo 1.4.1 de
-- Apple se quitaron de la app del paciente las metas automáticas que no
-- tenían fuente publicada (carbohidratos, líquidos en peritoneal, potasio
-- fuera de las etapas 4/5/hemodiálisis), así que ahora las fija el tratante.
--
-- Correr una vez en el SQL Editor de Supabase. Es idempotente.

alter table pacientes add column if not exists metas_sodio_mg numeric;
alter table pacientes add column if not exists metas_carbohidratos_g numeric;
alter table pacientes add column if not exists metas_calorias_kcal numeric;
alter table pacientes add column if not exists metas_liquidos_ml numeric;
