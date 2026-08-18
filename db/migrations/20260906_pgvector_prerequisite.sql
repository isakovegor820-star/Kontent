begin;

-- This deliberately sorts before the immutable 20260907 content-directory migration,
-- which is the first incremental migration to declare a vector column. Fresh database
-- bootstraps already install pgvector from db/schema.sql; legacy upgrades need the same
-- prerequisite without changing the checksum of an already released migration.
create extension if not exists vector;

commit;
