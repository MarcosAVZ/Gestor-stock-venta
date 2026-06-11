# Unidad Enum Specification

## Purpose

Define the set of valid `Unidad` values used throughout the system
(`@compras-whatsapp/shared` Zod schemas, Prisma enum, keyword normalizer for
user input). The current spec is a DELTA that adds `LOTE` to the value set
and to the keyword normalizer. All other enum members are preserved.

## MODIFIED Requirements

### Requirement: Valid Unidad values
The set of valid `Unidad` values MUST be
`UNIDAD | PAR | PACK | CAJA | LOTE | OTRO`.

(Previously: `UNIDAD | PAR | PACK | CAJA | OTRO`.)

#### Scenario: LOTE passes Zod validation
- GIVEN a value `"LOTE"`
- WHEN `UnidadSchema.parse` is called
- THEN parsing succeeds and the value is `"LOTE"`

#### Scenario: Existing UNIDAD still passes Zod (backward compat)
- GIVEN a value `"UNIDAD"`
- WHEN `UnidadSchema.parse` is called
- THEN parsing succeeds and the value is `"UNIDAD"` (unchanged from previous behavior)

#### Scenario: All six values are accepted
- GIVEN any of `"UNIDAD"`, `"PAR"`, `"PACK"`, `"CAJA"`, `"LOTE"`, `"OTRO"`
- WHEN `UnidadSchema.parse` is called
- THEN parsing succeeds for each

### Requirement: User-input keyword normalizer
The keyword normalizer MUST accept `lote` and `lotes` as additional
synonyms for the new `LOTE` value, in addition to the existing keywords
(`unidad`, `unidades`, `u`, `par`, `pares`, `pack`, `packs`, `caja`,
`cajas`, `otro`, `otra`).

(Previously: keywords were `unidad | unidades | u | par | pares | pack | packs | caja | cajas | otro | otra`.)

#### Scenario: "lote" normalizes to LOTE
- GIVEN user input `"lote"`
- WHEN `opcionUnidadSchema.parse` is called
- THEN the result is `"LOTE"`

#### Scenario: "lotes" normalizes to LOTE
- GIVEN user input `"lotes"`
- WHEN `opcionUnidadSchema.parse` is called
- THEN the result is `"LOTE"`

#### Scenario: "par" still normalizes to PAR (backward compat)
- GIVEN user input `"par"`
- WHEN `opcionUnidadSchema.parse` is called
- THEN the result is `"PAR"` (unchanged)

#### Scenario: Error message still lists the old keywords when input is unrecognized
- GIVEN user input `"foo"`
- WHEN `opcionUnidadSchema.parse` is called
- THEN the schema returns a Zod issue whose message mentions `unidad, par, pack, caja u otro` (existing message; `lote` MAY be added in a follow-up but is not required for v0)

### Requirement: Prisma Unidad enum
The PostgreSQL/MySQL `Unidad` enum MUST contain the new value `LOTE`
after the migration `add_unidad_lote` is applied. Existing rows MUST
be unaffected.

(Previously: the enum had 5 values, no `LOTE`.)

#### Scenario: Migration adds LOTE without breaking existing rows
- GIVEN the Prisma schema is updated to include `LOTE` and a migration named `add_unidad_lote` is generated
- WHEN the migration is applied to a database with existing rows
- THEN the enum type contains `LOTE`
- AND all existing rows with `UNIDAD` / `PAR` / `PACK` / `CAJA` / `OTRO` continue to be valid

#### Scenario: New inserts with unidad = LOTE succeed
- GIVEN a database with the migration applied
- WHEN an `ItemCompra` row is inserted with `unidad = LOTE`
- THEN the insert succeeds with no constraint violation

## ADDED Requirements

None beyond the modifications above.

## REMOVED Requirements

None. All existing enum values and keywords are preserved.
