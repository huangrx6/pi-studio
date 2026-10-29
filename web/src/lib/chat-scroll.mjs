/**
 * Chat transcript auto-follow policy.
 *
 * Keep the DOM-facing controller in App.tsx and the state transitions here so
 * the edge cases can be tested without mounting the whole application.
 */

export const FOLLOW_BOTTOM_THRESHOLD = 36;
export const SCROLL_INTENT_WINDOW_MS = 320;

/**
 * @param {{ scrollTop: number, clientHeight: number, scrollHeight: number }} metrics
 * @returns {number}
 */
export function distanceFromBottom({ scrollTop, clientHeight, scrollHeight }) {
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

/**
 * @param {{ scrollTop: number, clientHeight: number, scrollHeight: number }} metrics
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function isNearBottom(metrics, threshold = FOLLOW_BOTTOM_THRESHOLD) {
  return distanceFromBottom(metrics) <= threshold;
}

/**
 * A wheel is scroll-away intent as soon as it has any upward vertical
 * component and is not being consumed by an inner scrollable element such as
 * a code block. Trackpads often begin diagonally with a tiny vertical delta;
 * requiring the vertical axis to dominate makes that first gesture feel stuck.
 *
 * @param {{ deltaX: number, deltaY: number, nestedScrollable: boolean }} input
 * @returns {boolean}
 */
export function shouldReleaseFollowOnWheel({ deltaX, deltaY, nestedScrollable }) {
  if (nestedScrollable) return false;
  return deltaY < 0;
}

/**
 * Programmatic scrolling is trusted too, so only an explicit user gesture may
 * change follow mode. A no-op gesture leaves the current mode intact.
 *
 * @param {{ following: boolean, nearBottom: boolean, userInitiated: boolean, movedTowardStart: boolean }} input
 * @returns {boolean}
 */
export function resolveAutoFollow({ following, nearBottom, userInitiated, movedTowardStart }) {
  if (!userInitiated) return following;
  if (movedTowardStart) return false;
  if (nearBottom) return true;
  return following;
}
