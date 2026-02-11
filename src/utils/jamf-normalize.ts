// Centralized normalization for Jamf Classic/Modern enum-like strings.
// Jamf will often accept unknown strings but silently ignore them; normalizing
// common UI/LLM aliases prevents "worked but didn't apply" surprises.

export const normalizeEnum = (value: unknown, map: Record<string, string>): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  return map[key] ?? raw;
};

export const normalizePolicyFrequency = (input: unknown): string | undefined => {
  return normalizeEnum(input, {
    'once per computer': 'Once per computer',
    'once per user per computer': 'Once per user per computer',
    'once per user': 'Once per user',
    // Jamf Classic tenants vary; both "Once per day" and "Once every day" appear in the wild.
    // We preserve the caller intent and only normalize casing/aliases.
    'once per day': 'Once per day',
    'once every day': 'Once every day',
    'daily': 'Once per day',
    'once per week': 'Once per week',
    'once every week': 'Once every week',
    'weekly': 'Once per week',
    'once per month': 'Once per month',
    'once every month': 'Once every month',
    'monthly': 'Once per month',
    'ongoing': 'Ongoing',
  });
};

export const normalizePolicyNetworkRequirements = (input: unknown): string | undefined => {
  // Classic API enum: Any | Ethernet
  return normalizeEnum(input, {
    any: 'Any',
    ethernet: 'Ethernet',
  });
};

export const normalizePolicyMinimumNetworkConnection = (input: unknown): string | undefined => {
  // Classic API enum: No Minimum | Ethernet
  return normalizeEnum(input, {
    'no minimum': 'No Minimum',
    none: 'No Minimum',
    ethernet: 'Ethernet',
  });
};

export const normalizePolicyXmlFrequencies = (xml: string): string => {
  const input = String(xml ?? '');
  // Best-effort normalization: only touches <frequency>...</frequency> text nodes.
  return input.replace(/<frequency>([^<]*)<\/frequency>/gi, (_m, inner) => {
    const normalized = normalizePolicyFrequency(inner) ?? String(inner ?? '').trim();
    return `<frequency>${normalized}</frequency>`;
  });
};

export const normalizeScriptPriority = (input: unknown): string | undefined => {
  // Classic API values are typically "Before" or "After".
  return normalizeEnum(input, {
    before: 'Before',
    after: 'After',
  });
};

const deriveSearchTypeFromNameSuffix = (name: string): { name: string; derivedSearchType?: string } => {
  const raw = name.trim();
  const lower = raw.toLowerCase();

  // Match longer operators first.
  const suffixes: Array<{ suffix: string; canonical: string }> = [
    { suffix: ' is not', canonical: 'is not' },
    { suffix: ' not like', canonical: 'not like' },
    { suffix: ' starts with', canonical: 'starts with' },
    { suffix: ' ends with', canonical: 'ends with' },
    { suffix: ' contains', canonical: 'like' }, // Classic tends to use "like" for substring matches.
    { suffix: ' like', canonical: 'like' },
    { suffix: ' is', canonical: 'is' },
    { suffix: ' equals', canonical: 'is' },
    { suffix: ' equal', canonical: 'is' },
  ];

  for (const { suffix, canonical } of suffixes) {
    if (lower.endsWith(suffix)) {
      const base = raw.slice(0, raw.length - suffix.length).trim();
      if (base) return { name: base, derivedSearchType: canonical };
    }
  }

  return { name: raw };
};

export type SmartGroupCriterionLike = {
  name?: unknown;
  priority?: unknown;
  and_or?: unknown;
  search_type?: unknown;
  value?: unknown;
  opening_paren?: unknown;
  closing_paren?: unknown;
};

export const normalizeSmartGroupCriterion = (criterion: SmartGroupCriterionLike): SmartGroupCriterionLike => {
  const rawName = typeof criterion.name === 'string' ? criterion.name : String(criterion.name ?? '');
  const split = deriveSearchTypeFromNameSuffix(rawName);

  const andOr = normalizeEnum(criterion.and_or, { and: 'and', or: 'or' }) ?? String(criterion.and_or ?? '').trim();
  const searchTypeRaw = String(criterion.search_type ?? '').trim();

  const searchTypeNormalized =
    // Prefer explicit search_type if present; otherwise use derived from name suffix.
    (searchTypeRaw
      ? normalizeEnum(searchTypeRaw, {
          equals: 'is',
          'not equal': 'is not',
          contains: 'like',
        }) ?? searchTypeRaw
      : split.derivedSearchType) ?? searchTypeRaw;

  // Normalize a few common operator strings to the lowercase Classic style.
  const canonicalSearchType = normalizeEnum(searchTypeNormalized, {
    is: 'is',
    'is not': 'is not',
    like: 'like',
    'not like': 'not like',
    contains: 'like',
  });

  return {
    ...criterion,
    name: split.name,
    and_or: andOr,
    search_type: canonicalSearchType ?? searchTypeNormalized,
    // Preserve priority/value/parens as-is; other layers validate empties.
  };
};
