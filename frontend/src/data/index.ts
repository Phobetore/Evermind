import { createHttpSource } from "./http";
import type { DataSource } from "./source";

/** The data source the interface talks to. */
export const data: DataSource = createHttpSource();

export type * from "./source";
export { DataError } from "./errors";
export { onLocked } from "./http/request";
