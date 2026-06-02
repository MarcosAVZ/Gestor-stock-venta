/**
 * @compras-whatsapp/shared — barrel export de enums.
 *
 * Los tipos `*Type` están para callers que quieran importar el tipo
 * bajo un alias distinto al valor (ej: `type ConversationStateType`).
 * En runtime y como tipo, el valor y el type son los mismos.
 */
export { ConversationState } from './ConversationState.ts';
export type { ConversationState as ConversationStateType } from './ConversationState.ts';
export { Unidad } from './Unidad.ts';
export type { Unidad as UnidadType } from './Unidad.ts';
export { Moneda } from './Moneda.ts';
export type { Moneda as MonedaType } from './Moneda.ts';
