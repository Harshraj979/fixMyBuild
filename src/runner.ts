import { spawn } from 'node:child_process';

export interface RunResult {
  exitCode: number;
  output: string;
}

export interface RunOptions {
  timeoutMs?: number;
}

export function run(
  command: string,
  cwd: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 180000; // 3-minute default timeout

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RunResult) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      }
    };

    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    child.stdout?.on('data', (data: Buffer) => chunks.push(data));
    child.stderr?.on('data', (data: Buffer) => chunks.push(data));

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // process may have already exited
      }
      finish({
        exitCode: 124, // standard timeout exit code
        output: Buffer.concat(chunks).toString('utf-8') + '\n[Command timed out after 3 minutes]',
      });
    }, timeoutMs);

    child.on('close', (code) => {
      finish({
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString('utf-8'),
      });
    });

    child.on('error', (err) => {
      finish({
        exitCode: 1,
        output: err.message,
      });
    });
  });
}
