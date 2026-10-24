import type { DataSource } from '../generated/prisma/enums.js';

/** The two human-surveyed 2024 fieldwork imports (u/eggmayosandwich): the March pilot and the Aug-Oct expanded survey. */
export const FIELDWORK_SOURCES = ['FIELDWORK_2024', 'FIELDWORK_2024_EXPANDED'] as const satisfies readonly DataSource[];

export const isFieldwork = (source: string): boolean => (FIELDWORK_SOURCES as readonly string[]).includes(source);
