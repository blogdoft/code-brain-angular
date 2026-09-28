import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { isWithin, walkFiles } from './file-walker.js';
import type { AnalysisInput, DiscoveredProject, DiscoveryResult } from './model.js';

const WORKSPACE_FILE = 'angular.json';
const GENERIC_PROJECT_FILES = new Set(['tsconfig.json', 'jsconfig.json', 'package.json']);

/** `claimedDir` is the tree a project owns: an Angular workspace claims its whole directory. */
type ProjectDraft = Omit<DiscoveredProject, 'excludedDirs'> & { claimedDir: string };

/**
 * Builds the unique set of projects to analyze from the resolved input. Angular workspaces
 * (`angular.json`) contribute one project per entry and claim their whole directory tree; any
 * other directory holding a `tsconfig.json`/`jsconfig.json`/`package.json` becomes a generic
 * TypeScript/JavaScript project. No project is ever analyzed twice.
 */
export function discoverProjects(input: AnalysisInput): DiscoveryResult {
  const warnings: string[] = [];
  const rootDirectory = input.type === 'directory' ? input.path : dirname(input.path);
  const drafts: ProjectDraft[] = [];

  if (input.type === 'workspace') {
    drafts.push(...readWorkspace(input.path, warnings));
  } else if (input.type === 'project') {
    drafts.push(genericProject(dirname(input.path), input.path));
  } else {
    drafts.push(...scanDirectory(input.path, warnings));
  }

  const unique = new Map<string, ProjectDraft>();
  for (const draft of drafts) {
    if (!unique.has(draft.sourceRoot)) {
      unique.set(draft.sourceRoot, draft);
    }
  }

  const all = [...unique.values()];
  const projects: DiscoveredProject[] = all
    .map(({ claimedDir: _claimed, ...project }) => ({
      ...project,
      // A project's own tree is never excluded: only directories strictly nested inside it.
      excludedDirs: [
        ...new Set(
          all
            .flatMap((other) => [other.sourceRoot, other.claimedDir])
            .filter((dir) => isWithin(project.sourceRoot, dir) && !isWithin(dir, project.sourceRoot)),
        ),
      ].sort(),
    }))
    .sort((a, b) => compare(a.name, b.name) || compare(a.sourceRoot, b.sourceRoot));

  disambiguateNames(projects);
  return { rootDirectory, projects, warnings };
}

function scanDirectory(directory: string, warnings: string[]): ProjectDraft[] {
  const found = walkFiles(directory, (name) => name === WORKSPACE_FILE || GENERIC_PROJECT_FILES.has(name));
  const workspaces = found.filter((file) => basename(file) === WORKSPACE_FILE);
  const workspaceDirs = workspaces.map((file) => dirname(file));

  const drafts = workspaces.flatMap((file) => readWorkspace(file, warnings));

  const genericDirs = [...new Set(found.filter((f) => basename(f) !== WORKSPACE_FILE).map((f) => dirname(f)))]
    .filter((dir) => !workspaceDirs.some((ws) => isWithin(ws, dir)))
    .sort();

  for (const dir of genericDirs) {
    const declaredIn = ['package.json', 'tsconfig.json', 'jsconfig.json']
      .map((name) => join(dir, name))
      .find((file) => existsSync(file))!;
    drafts.push(genericProject(dir, declaredIn));
  }

  return drafts;
}

function genericProject(dir: string, declaredIn: string): ProjectDraft {
  const explicitConfig = /^(tsconfig.*|jsconfig)\.json$/i.test(basename(declaredIn)) ? declaredIn : undefined;
  const configFile =
    explicitConfig ??
    [join(dir, 'tsconfig.json'), join(dir, 'jsconfig.json')].find((file) => existsSync(file));

  return {
    name: packageName(dir) ?? basename(dir),
    kind: configFile && basename(configFile).startsWith('tsconfig') ? 'typescript' : 'javascript',
    rootDir: dir,
    sourceRoot: dir,
    configFile,
    declaredIn,
    claimedDir: dir,
  };
}

interface WorkspaceProject {
  root?: string;
  sourceRoot?: string;
  projectType?: string;
  architect?: Record<string, { options?: { tsConfig?: string } }>;
  targets?: Record<string, { options?: { tsConfig?: string } }>;
}

function readWorkspace(file: string, warnings: string[]): ProjectDraft[] {
  const workspaceDir = dirname(file);
  const errors: ParseError[] = [];
  const content = parseJsonc(readFileSync(file, 'utf8'), errors, { allowTrailingComma: true }) as
    { projects?: Record<string, WorkspaceProject> } | undefined;

  if (!content?.projects || errors.length > 0) {
    warnings.push(`Could not read the projects of '${file}'.`);
    return [];
  }

  return Object.entries(content.projects).map(([name, project]) => {
    const rootDir = resolve(workspaceDir, project.root ?? '');
    const sourceRoot = resolve(workspaceDir, project.sourceRoot ?? join(project.root ?? '', 'src'));
    const targets = project.architect ?? project.targets ?? {};
    const declared = targets['build']?.options?.tsConfig;
    const configFile = [
      declared ? resolve(workspaceDir, declared) : undefined,
      join(rootDir, 'tsconfig.app.json'),
      join(rootDir, 'tsconfig.lib.json'),
      join(rootDir, 'tsconfig.json'),
      join(workspaceDir, 'tsconfig.json'),
    ].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));

    const draft: ProjectDraft = {
      name,
      kind: 'angular',
      rootDir,
      sourceRoot,
      configFile,
      declaredIn: file,
      claimedDir: workspaceDir,
    };
    return draft;
  });
}

function packageName(dir: string): string | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const name = (JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Two projects with the same logical name would collide in CIIR ids; suffix the later ones. */
function disambiguateNames(projects: DiscoveredProject[]): void {
  const seen = new Map<string, number>();
  for (const project of projects) {
    const count = seen.get(project.name) ?? 0;
    seen.set(project.name, count + 1);
    if (count > 0) {
      project.name = `${project.name}~${count + 1}`;
    }
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
