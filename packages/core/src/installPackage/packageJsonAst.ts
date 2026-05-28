import ts from 'typescript';

export interface DuplicateCommandKey {
  readonly commandName: string;
}

export function findDuplicateCommandKeys(packageJsonText: string): readonly DuplicateCommandKey[] {
  const source = ts.parseJsonText('package.json', packageJsonText);
  const rootExpression = source.statements[0]?.expression;
  if (!rootExpression || !ts.isObjectLiteralExpression(rootExpression)) return [];

  const aharness = readObjectProperty(rootExpression, 'aharness');
  const aharnessPackage = aharness ? readObjectProperty(aharness, 'package') : undefined;
  const commands = aharnessPackage ? readObjectProperty(aharnessPackage, 'commands') : undefined;
  if (!commands) return [];

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const property of commands.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameText(property.name);
    if (name === undefined) continue;
    if (seen.has(name)) {
      duplicates.add(name);
    } else {
      seen.add(name);
    }
  }

  return [...duplicates].sort().map((commandName) => ({ commandName }));
}

function readObjectProperty(
  obj: ts.ObjectLiteralExpression,
  key: string,
): ts.ObjectLiteralExpression | undefined {
  for (const property of obj.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameText(property.name) !== key) continue;
    if (ts.isObjectLiteralExpression(property.initializer)) return property.initializer;
    return undefined;
  }
  return undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isIdentifier(name)) {
    return name.text;
  }
  return undefined;
}
