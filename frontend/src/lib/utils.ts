/** Utility functions. */

import { type ClassValue, clsx } from "clsx";

/**
 * Merge Tailwind class names with clsx.
 * Install clsx if using this helper: npm install clsx
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}
