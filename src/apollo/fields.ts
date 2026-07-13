/**
 * Projects an Apollo response down to a caller-supplied set of dot-path fields,
 * so an MCP client can fetch only the fields it needs instead of the full
 * record (a single Apollo organization or person record is several KB; a
 * 100-item search page adds up fast).
 *
 * Paths use dot notation and descend through nested objects. When a path
 * crosses an array, the remaining path is applied to every element, e.g.
 * `employment_history.organization_name` keeps just that field of each
 * position. A path that names a whole subtree (`primary_phone`) keeps it
 * intact. Unknown paths are skipped silently; an empty list returns the value
 * unchanged.
 */
export function selectFields<T>(value: T, fields: readonly string[]): T | unknown {
  const paths = fields
    .map(field => field.trim())
    .filter(Boolean)
    .map(field => field.split('.').map(segment => segment.trim()).filter(Boolean))
    .filter(segments => segments.length > 0);

  if (paths.length === 0) {
    return value;
  }

  return project(value, paths);
}

function project(value: unknown, paths: string[][]): unknown {
  if (Array.isArray(value)) {
    return value.map(item => project(item, paths));
  }

  if (value === null || typeof value !== 'object') {
    // A deeper path was requested but there is nothing to descend into.
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const wholeKeys = new Set<string>();
  const nested = new Map<string, string[][]>();

  for (const [head, ...rest] of paths) {
    if (head === undefined) {
      continue;
    }
    if (rest.length === 0) {
      wholeKeys.add(head);
    } else {
      const group = nested.get(head) ?? [];
      group.push(rest);
      nested.set(head, group);
    }
  }

  for (const key of new Set([...wholeKeys, ...nested.keys()])) {
    if (!(key in source)) {
      continue;
    }

    if (wholeKeys.has(key)) {
      result[key] = source[key];
    } else {
      result[key] = project(source[key], nested.get(key) as string[][]);
    }
  }

  return result;
}
