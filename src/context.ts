import { readFile, access } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

export interface ProjectContext {
  nodeVersion: string;
  npmVersion: string;
  packageManagerVersion?: string;
  os: string;
  arch: string;
  cwd: string;
  packageJson: string | null;
  lockfileType: 'npm' | 'yarn' | 'pnpm' | 'bun' | null;
  tsconfig: string | null;
  nvmrc: string | null;
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

function tryExec(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

async function detectLockfile(cwd: string): Promise<ProjectContext['lockfileType']> {
  const lockfiles: [string, ProjectContext['lockfileType']][] = [
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
  ];
  for (const [file, type] of lockfiles) {
    try {
      await access(join(cwd, file));
      return type;
    } catch {
      continue;
    }
  }
  return null;
}

export async function gatherContext(cwd: string): Promise<ProjectContext> {
  const [packageJson, tsconfig, nvmrc, lockfileType] = await Promise.all([
    tryRead(join(cwd, 'package.json')),
    tryRead(join(cwd, 'tsconfig.json')),
    tryRead(join(cwd, '.nvmrc')),
    detectLockfile(cwd),
  ]);

  const pm = lockfileType ?? 'npm';
  const packageManagerVersion = tryExec(`${pm} --version`);

  return {
    nodeVersion: tryExec('node --version'),
    npmVersion: tryExec('npm --version'),
    packageManagerVersion: packageManagerVersion !== 'unknown' ? `${pm}@${packageManagerVersion}` : undefined,
    os: process.platform,
    arch: process.arch,
    cwd,
    packageJson,
    lockfileType,
    tsconfig,
    nvmrc,
  };
}
