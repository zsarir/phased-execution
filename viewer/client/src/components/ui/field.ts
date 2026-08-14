/**
 * THE form-control class, defined once.
 *
 * Four files carried this string as their own const, and every copy's
 * `text-sm` (13.2px) beat the `@layer base` 16px input floor — which is how
 * focusing the Agent launcher's selects zoomed iOS and left it zoomed. The
 * font floor now wins globally via the unlayered coarse-pointer rule in
 * theme.css; this class adds the thumb floor (the Button idiom: 44px only
 * where there is no hover). A source-text guard in styles/touch.test.ts holds
 * the literal to exactly one definition under src/.
 */
export const field =
  'h-9 [@media(hover:none)]:min-h-(--tap-min) rounded border border-rule bg-ground px-2 text-sm disabled:opacity-50';
