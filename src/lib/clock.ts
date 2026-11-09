/**
 * The notification pipeline's idea of "now". Production reads the real clock; tests pin it to a fixed time of day
 * so quiet hours (23:00–07:00 Dhaka) can't make a test depend on when it happens to run.
 */
export const clock: { now: () => Date } = { now: () => new Date() };
