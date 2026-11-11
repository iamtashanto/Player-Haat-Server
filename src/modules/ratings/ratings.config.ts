/** Rating rules. All numbers live here so they can be tuned without touching logic. */
export const RATING_RULES = {
  /** Reviews shown as an average (and a "New" badge removed) only once this many are revealed per sport. */
  minRevealedForAverage: 3,
  /** Weight of the platform mean in the damped (Bayesian) average used for ordering/featuring. */
  bayesWeight: 5,
  /** Prior used when the platform has no revealed reviews yet. */
  fallbackPrior: 3.5,
  disputeWindowDays: 7,
  replyMaxChars: 300,
  replyEditHours: 24,
  /** An organiser is flagged when more than this share of the players they marked were no-shows… */
  flagNoShowShare: 0.5,
  /** …across at least this many games. */
  flagMinGames: 3,
} as const;

/** (c·avg + w·prior) / (c + w): a player with few reviews sits near the platform mean, not at 5.0. */
export const bayesAverage = (avg: number, count: number, prior: number, weight: number = RATING_RULES.bayesWeight) =>
  (count * avg + weight * prior) / (count + weight);

/** What a public screen may show: no average until enough reviews are revealed; "New" until then. */
export const publicRating = (avg: number, count: number) => {
  const isNew = count < RATING_RULES.minRevealedForAverage;
  return { average: isNew ? 0 : Math.round(avg * 100) / 100, count, isNew };
};
