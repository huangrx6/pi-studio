type ScrollMetrics = Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>;

/**
 * Chat transcript auto-follow policy.
 *
 * Keep the DOM-facing controller in App.tsx and the state transitions here so
 * the edge cases can be tested without mounting the whole application.
 */

export const FOLLOW_BOTTOM_THRESHOLD = 36;
export const SCROLL_INTENT_WINDOW_MS = 320;

export function distanceFromBottom({ scrollTop, clientHeight, scrollHeight }: ScrollMetrics) {
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function isNearBottom(metrics: ScrollMetrics, threshold = FOLLOW_BOTTOM_THRESHOLD) {
  return distanceFromBottom(metrics) <= threshold;
}

/**
 * A wheel is scroll-away intent as soon as it has any upward vertical
 * component and is not being consumed by an inner scrollable element such as
 * a code block. Trackpads often begin diagonally with a tiny vertical delta;
 * requiring the vertical axis to dominate makes that first gesture feel stuck.
 */
export function shouldReleaseFollowOnWheel({ deltaY, nestedScrollable }: { deltaX: number; deltaY: number; nestedScrollable: boolean }) {
  if (nestedScrollable) return false;
  return deltaY < 0;
}

/**
 * A wheel event can bubble out of an overflowing code block or tool result.
 * While that inner element can still scroll in the requested direction, the
 * transcript itself must remain pinned.
 */
export function nestedScrollableConsumesWheel(target: EventTarget | null, viewport: HTMLElement | null, deltaY: number) {
  if (!viewport || !(target instanceof Element) || !deltaY) return false;
  let node = target instanceof HTMLElement ? target : target.parentElement;
  while (node && node !== viewport) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        if (deltaY < 0 && node.scrollTop > 1) return true;
        if (deltaY > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * A live panel (the streaming thinking body) follows its newest line only while
 * the reader stays at that bottom edge.
 *
 * An upward wheel is an immediate release, because the next token arrives before
 * the browser has even applied the scroll; a scroll that leaves the bottom
 * (scrollbar drag) releases too. Coming back to the bottom re-arms following.
 */
export function resolveLiveFollow({ nearBottom = false, wheelUp = false }: { nearBottom?: boolean; wheelUp?: boolean }) {
  if (wheelUp) return false;
  return nearBottom;
}

/**
 * Programmatic scrolling is trusted too, so only an explicit user gesture may
 * change follow mode. A no-op gesture leaves the current mode intact.
 */
export function resolveAutoFollow({ following, nearBottom, userInitiated, movedTowardStart }: { following: boolean; nearBottom: boolean; userInitiated: boolean; movedTowardStart: boolean }) {
  if (!userInitiated) return following;
  if (movedTowardStart) return false;
  if (nearBottom) return true;
  return following;
}
