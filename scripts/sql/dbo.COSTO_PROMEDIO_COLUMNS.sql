-- Solo crea columnas COSTO_PROMEDIO si NO existen (no suma ni calcula nada).
-- Si PRODUCTOS, PRECIOS e INVSALDO ya tienen COSTO_PROMEDIO, este script no hace cambios.
-- Uso opcional en BD nuevas: Actualizador BD o node scripts/seed-update-query-costo-promedio.js

-- @UPDATER_CHUNK COSTO_PROMEDIO_PRECIOS
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'dbo.PRECIOS') AND name = N'COSTO_PROMEDIO'
)
BEGIN
  ALTER TABLE dbo.PRECIOS ADD COSTO_PROMEDIO DECIMAL(18, 3) NULL;
END;

-- @UPDATER_CHUNK COSTO_PROMEDIO_INVSALDO
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'dbo.INVSALDO') AND name = N'COSTO_PROMEDIO'
)
BEGIN
  ALTER TABLE dbo.INVSALDO ADD COSTO_PROMEDIO DECIMAL(18, 3) NULL;
END;
