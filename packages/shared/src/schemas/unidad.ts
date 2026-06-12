/**
 * @compras-whatsapp/shared — UnidadSchema (Zod).
 *
 * Validates exact Unidad enum values. Used for strict validation
 * of persisted data (as opposed to opcionUnidadSchema which maps
 * user keywords to enum values).
 */
import { z } from 'zod';

import { Unidad } from '../enums/Unidad.ts';

export const UnidadSchema = z.nativeEnum(Unidad);
