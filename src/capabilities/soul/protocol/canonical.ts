// Deterministic JSON canonicalization: sort object keys recursively so that
// two structurally-equal objects produce byte-identical serializations. This
// is the form we sign — over canonical bytes, not native JSON.stringify
// output — so that signatures don't depend on key-insertion order.
//
// Extracted from identity.ts because both Phase 3 document signing and
// Phase 5 envelope signing need it.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') +
    '}'
  );
}
