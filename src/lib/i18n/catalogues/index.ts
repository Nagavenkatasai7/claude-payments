import { en } from './en';

export type MessageKey = keyof typeof en;
// One line per language. The type check requires every registered catalogue to carry every en key.
export const CATALOGUES = { en } satisfies Record<string, Record<MessageKey, string>>;
export type Locale = keyof typeof CATALOGUES;
