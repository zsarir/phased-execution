import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Join class names, letting a later utility win over an earlier one of the same
 * kind. Without the merge step a component's default (`px-3`) and a caller's
 * override (`px-6`) both land in `class` and the cascade — not the caller —
 * decides, which reads as "the prop did nothing".
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
