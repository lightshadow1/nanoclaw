const KEYWORDS = [
  'decided',
  'deadline',
  'remember',
  'urgent',
  'important',
  'never',
  'always',
  'cancel',
  'schedule',
];

const MUNDANE = /^(ok|okay|thanks|thx|k|yes|no|lol|haha|sure|cool|nice)\.?!?$/i;
const URL_RE = /\bhttps?:\/\/\S+/i;

export interface ScoreInput {
  content: string;
  isAddressed: boolean;
}

export function heuristicScore({ content, isAddressed }: ScoreInput): number {
  const trimmed = content.trim();
  if (!trimmed) return 1;

  let score = 3;

  const lower = trimmed.toLowerCase();
  if (KEYWORDS.some((kw) => lower.includes(kw))) score += 3;

  if (isAddressed) score += 2;
  if (trimmed.length > 200) score += 1;
  if (URL_RE.test(trimmed)) score += 2;
  if (trimmed.length <= 3 || MUNDANE.test(trimmed)) score -= 2;

  if (score < 1) return 1;
  if (score > 10) return 10;
  return score;
}
