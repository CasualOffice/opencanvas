// Popover placement, kept apart from React so it can be unit tested.

/**
 * Where a popover goes: below the anchor, or above it when there is more room
 * there, clamped inside the shell. `maxHeight` keeps long menus scrollable
 * inside the visible area instead of running off the bottom.
 */
export function placePopover(
  anchor: { left: number; right: number; top: number; bottom: number },
  shell: { width: number; height: number },
  size: { width: number; height: number },
  alignRight = false,
): { left: number; top: number; maxHeight: number } {
  const gap = 6;
  const edge = 8;
  const below = shell.height - anchor.bottom - gap - edge;
  const above = anchor.top - gap - edge;
  const fitsBelow = size.height <= below;
  const useAbove = !fitsBelow && above > below;
  const maxHeight = Math.max(120, Math.floor(useAbove ? above : below));
  const h = Math.min(size.height, maxHeight);
  const top = useAbove ? Math.max(edge, anchor.top - gap - h) : Math.max(edge, Math.min(anchor.bottom + gap, shell.height - edge - h));
  let left = alignRight ? anchor.right - size.width : anchor.left;
  left = Math.max(edge, Math.min(left, shell.width - size.width - edge));
  return { left, top, maxHeight };
}
