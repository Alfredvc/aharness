/**
 * Compute the dotted state id of the enclosing state for a given AST node.
 *
 * The user FSM declares per-state metadata as:
 *
 *     states: {
 *       parent: {
 *         states: {
 *           child: {
 *             meta: { harness: state({ exits: { ... } }) },   <-- the call expression
 *           },
 *         },
 *       },
 *     }
 *
 * Walking up parents from the `state({ exits: { ... } })` call yields a chain of
 * `PropertyAssignment` nodes (`harness`, `meta`, `child`, `parent`,
 * `states`, …). The state-id segments are exactly those `PropertyAssignment`s
 * whose enclosing `ObjectLiteralExpression` is the value of a sibling
 * `PropertyAssignment` named `states` (i.e. they live directly under a
 * `states: { … }` object). Collected outermost-first, joined with `.`, this
 * matches the dotted form `stateKeyPath` produces from a loaded XState
 * machine — the verifier and submit-tool builder both key by that.
 *
 * Returns `null` when no state id can be determined. Common reasons:
 *   - the call sits at the top level, not inside a `states` chain;
 *   - a property key is a computed expression (`[k]: …`) the loader can't
 *     read statically.
 *
 * Spread elements (`{ ...common, meta: … }`) are not specially supported in
 * v1; if the user spreads metadata into a state config, the call's textual
 * location still resolves correctly, but a spread-only state config (no
 * direct PropertyAssignment chain back to `states`) cannot be matched.
 */
import ts from 'typescript';

export function getEnclosingStateId(node: ts.Node): string | null {
  const segments: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isPropertyAssignment(current)) {
      const objLit = current.parent;
      if (ts.isObjectLiteralExpression(objLit)) {
        const grand = objLit.parent;
        if (ts.isPropertyAssignment(grand) && getStaticName(grand) === 'states') {
          const name = getStaticName(current);
          if (name === null) {
            // Computed/dynamic key — we can't know the state id statically.
            // Walking further up may still find an outer chain, but that
            // outer chain's segments would be incomplete. Bail.
            return null;
          }
          segments.unshift(name);
        }
      }
    }
    current = current.parent;
  }
  if (segments.length === 0) return null;
  return segments.join('.');
}

function getStaticName(pa: ts.PropertyAssignment): string | null {
  const name = pa.name;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}
