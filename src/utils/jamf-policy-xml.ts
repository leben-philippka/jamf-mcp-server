const decodeXml = (s: string): string => {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
};

export type ParsedSelfServiceCategory = {
  id?: number;
  name?: string;
  display_in?: boolean;
  feature_in?: boolean;
};

export const parsePolicySelfServiceFromXml = (
  xml: string
): {
  self_service_category?: string;
  self_service_categories: ParsedSelfServiceCategory[];
} => {
  const text = String(xml ?? '');

  const catNameMatch = text.match(/<self_service_category>\s*([\s\S]*?)\s*<\/self_service_category>/i);
  const self_service_category = catNameMatch ? decodeXml(catNameMatch[1].trim()) : undefined;

  const categoriesBlockMatch = text.match(/<self_service_categories>\s*([\s\S]*?)\s*<\/self_service_categories>/i);
  const categoriesBlock = categoriesBlockMatch ? categoriesBlockMatch[1] : '';

  const categories: ParsedSelfServiceCategory[] = [];
  const categoryMatches = categoriesBlock.matchAll(/<category>\s*([\s\S]*?)\s*<\/category>/gi);
  for (const m of categoryMatches) {
    const inner = m[1] ?? '';
    const idMatch = inner.match(/<id>\s*([0-9]+)\s*<\/id>/i);
    const nameMatch = inner.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
    const displayInMatch = inner.match(/<display_in>\s*(true|false)\s*<\/display_in>/i);
    const featureInMatch = inner.match(/<feature_in>\s*(true|false)\s*<\/feature_in>/i);

    const id = idMatch ? Number(idMatch[1]) : undefined;
    const name = nameMatch ? decodeXml(nameMatch[1].trim()) : undefined;
    const display_in = displayInMatch ? displayInMatch[1].toLowerCase() === 'true' : undefined;
    const feature_in = featureInMatch ? featureInMatch[1].toLowerCase() === 'true' : undefined;

    // Ignore empty nodes.
    if ((id === undefined || !Number.isFinite(id)) && !name) continue;

    categories.push({
      ...(Number.isFinite(id) ? { id } : {}),
      ...(name ? { name } : {}),
      ...(display_in !== undefined ? { display_in } : {}),
      ...(feature_in !== undefined ? { feature_in } : {}),
    });
  }

  return { self_service_category, self_service_categories: categories };
};

