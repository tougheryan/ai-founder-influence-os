import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export const NEXT_ROUTE_HTTP_METHODS = Object.freeze([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const);

const NEXT_ROUTE_HTTP_METHOD_SET = new Set<string>(NEXT_ROUTE_HTTP_METHODS);

export type HostedPageRoute = {
  file: string;
  pathname: string;
};

export type HostedApiRoute = {
  file: string;
  methods: string[];
  pathname: string;
};

export type HostedRouteInventory = {
  apiRoutes: HostedApiRoute[];
  pageRoutes: HostedPageRoute[];
};

async function walk(root: string, files: string[] = []): Promise<string[]> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(candidate, files);
    } else if (entry.isFile() && (entry.name === 'page.tsx' || entry.name === 'route.ts')) {
      files.push(candidate);
    }
  }
  return files;
}

function sampleSegment(segment: string): string[][] {
  if (/^\([^/]+\)$/.test(segment) || segment.startsWith('@')) return [[]];
  if (/^\[\[\.\.\..+\]\]$/.test(segment)) {
    return [[], ['__aifios_optional__', '__aifios_path__']];
  }
  if (/^\[\.\.\..+\]$/.test(segment)) return [['__aifios_catchall__', '__aifios_path__']];
  if (/^\[[^/]+\]$/.test(segment)) return [['__aifios_param__']];
  if (segment.startsWith('(')) {
    throw new Error(`unsupported App Router intercepting segment in hosted route inventory: ${segment}`);
  }
  return [[segment]];
}

function pathnamesFor(appRoot: string, file: string): string[] {
  const directory = path.dirname(path.relative(appRoot, file));
  const filesystemSegments = directory === '.' ? [] : directory.split(path.sep);
  let candidates: string[][] = [[]];
  for (const segment of filesystemSegments) {
    candidates = candidates.flatMap((prefix) => (
      sampleSegment(segment).map((sample) => [...prefix, ...sample])
    ));
  }
  return [...new Set(candidates.map((segments) => (
    segments.length ? `/${segments.join('/')}` : '/'
  )))];
}

function exportedMethods(source: string): string[] {
  const methods = new Set<string>();
  const sourceFile = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const isExported = (node: ts.Node) => (
    ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.name) {
      if (NEXT_ROUTE_HTTP_METHOD_SET.has(statement.name.text)) methods.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && NEXT_ROUTE_HTTP_METHOD_SET.has(declaration.name.text)) {
          methods.add(declaration.name.text);
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        throw new Error('star exports are not allowed in App Router route files because their HTTP methods cannot be inventoried');
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        if (NEXT_ROUTE_HTTP_METHOD_SET.has(element.name.text)) methods.add(element.name.text);
      }
    }
  }
  return [...methods].sort();
}

/**
 * Discovers every App Router surface that the hosted-license proxy must gate.
 * Dynamic segments are deliberately materialized as real sample path values so
 * callers exercise the proxy with URLs Next will match in production.
 */
export async function hostedRouteInventory(appRoot = path.join(process.cwd(), 'app')): Promise<HostedRouteInventory> {
  const files = await walk(appRoot);
  const pageRoutes: HostedPageRoute[] = [];
  const apiRoutes: HostedApiRoute[] = [];

  for (const file of files.sort()) {
    const relativeFile = path.relative(appRoot, file);
    const pathnames = pathnamesFor(appRoot, file);
    if (path.basename(file) === 'page.tsx') {
      for (const pathname of pathnames) pageRoutes.push({ file: relativeFile, pathname });
    } else {
      const methods = exportedMethods(await readFile(file, 'utf-8'));
      if (!methods.length) throw new Error(`could not discover an HTTP method exported by ${file}`);
      for (const pathname of pathnames) apiRoutes.push({ file: relativeFile, methods, pathname });
    }
  }

  return { apiRoutes, pageRoutes };
}
