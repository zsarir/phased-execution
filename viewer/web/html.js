/** The rendering runtime: preact + htm, bound once and shared. */
import { h, render, Fragment } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
export { h, render, Fragment };
export {
  useState, useEffect, useMemo, useRef, useCallback, useReducer, useLayoutEffect,
} from 'preact/hooks';
