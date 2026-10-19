#!/usr/bin/env node

import { createInterface } from 'node:readline';
import ora from 'ora';
import chalk from 'chalk';
import { gatherContext } from './context.js';
import { analyze, type FixStep, type Diagnosis } from './analyzer.js';
import { run } from './runner.js';
import { printDiagnosis, printError, printInfo } from './ui.js';

const DEFAULT_MODEL = 'qwen2.5-coder:7b';

const HELP = `
${chalk.bold('fixmybuild')} — Autonomous AI build error resolver (local, private, open-source)

${chalk.dim('Usage:')}
  ${chalk.cyan('command 2>&1 | fixmybuild')}         Pipe error output directly
  ${chalk.cyan('fixmybuild "npm run build"')}         Run a command and analyze on failure
  ${chalk.cyan('fixmybuild --auto "npm run build"')}  Autonomous repair loop: runs, fixes, and retests until clean
  ${chalk.cyan('fixmybuild --apply "npm run build"')} Auto-execute all fixes without confirmation
  ${chalk.cyan('fixmybuild --paste')}                 Paste error output manually

${chalk.dim('Options:')}
  -a, --auto        Full autonomous repair loop (diagnose -> execute -> verify -> retry)
  -y, --apply       Auto-run all fix commands sequentially without confirmation
  -p, --paste       Paste error output manually
  --model <name>    Ollama model (default: ${DEFAULT_MODEL})
  -h, --help        Show this help

${chalk.dim('Environment:')}
  OLLAMA_HOST       Ollama server URL (default: http://127.0.0.1:11434)
`;

interface CliArgs {
  command: string | null;
  model: string;
  autoApply: boolean;
  autonomousLoop: boolean;
  paste: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: null,
    model: DEFAULT_MODEL,
    autoApply: false,
    autonomousLoop: false,
    paste: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model' && argv[i + 1]) {
      args.model = argv[++i];
    } else if (arg.startsWith('--model=')) {
      args.model = arg.slice('--model='.length);
    } else if (arg === '--apply' || arg === '-y') {
      args.autoApply = true;
    } else if (arg === '--auto' || arg === '-a') {
      args.autonomousLoop = true;
      args.autoApply = true;
    } else if (arg === '--paste' || arg === '-p') {
      args.paste = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      args.command = arg;
    }
  }

  return args;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readPaste(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    chalk.dim('Paste your error output, then press Ctrl+D (Unix) or Ctrl+Z+Enter (Windows):'),
  );
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines.join('\n');
}

function promptConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

async function executeFixPlan(fixes: FixStep[], cwd: string): Promise<boolean> {
  console.log(chalk.bold.green(`\n⚡ Executing ${fixes.length} fix command(s) in sequence:`));
  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];
    const label = `[${i + 1}/${fixes.length}] ${fix.command}`;
    const spinner = ora({
      text: chalk.cyan(`Running: ${label} (${fix.description})`),
      spinner: 'dots',
    }).start();

    const res = await run(fix.command, cwd);
    if (res.exitCode === 0) {
      spinner.succeed(chalk.green(`Done: ${label}`));
    } else {
      spinner.fail(chalk.red(`Failed: ${label}`));
      printError(`Command failed with exit code ${res.exitCode}:`);
      console.log(chalk.dim(res.output.slice(-600)));
      return false;
    }
  }
  return true;
}

async function runDiagnosisAndFix(
  initialError: string,
  targetCommand: string | null,
  args: CliArgs,
  cwd: string,
  isPiped: boolean,
): Promise<void> {
  let currentError = initialError;
  const maxAttempts = args.autonomousLoop ? 3 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      console.log(chalk.bold.yellow(`\n↻ Autonomous self-healing retry ${attempt}/${maxAttempts}...`));
    }

    const spinner = ora({ text: 'Gathering project context...', spinner: 'dots' }).start();
    const context = await gatherContext(cwd);
    spinner.text = `Analyzing terminal error with ${chalk.bold(args.model)}...`;

    let diagnosis: Diagnosis;
    try {
      diagnosis = await analyze(currentError, context, args.model);
      spinner.stop();
    } catch (err: unknown) {
      spinner.stop();
      const msg = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && err.cause && typeof err.cause === 'object'
          ? (err.cause as Record<string, unknown>)
          : {};

      if (msg.includes('ECONNREFUSED') || cause['code'] === 'ECONNREFUSED') {
        printError('Cannot connect to Ollama. Is it running?');
        printInfo('Start it with: ollama serve');
        printInfo(`Then pull the model: ollama pull ${args.model}`);
      } else if (msg.includes('not found')) {
        printError(`Model "${args.model}" not found.`);
        printInfo(`Pull it with: ollama pull ${args.model}`);
      } else {
        printError(`Analysis failed: ${msg}`);
      }
      process.exit(1);
    }

    printDiagnosis(diagnosis);

    if (diagnosis.fixes.length === 0) {
      printInfo('No automated fix commands were identified. Manual intervention required.');
      process.exit(1);
    }

    const canPrompt = !isPiped && !args.paste;
    let shouldRun = args.autoApply;

    if (!shouldRun) {
      if (!canPrompt) {
        printInfo('Piped/paste mode: run with --auto or --apply to execute fixes automatically.');
        process.exit(0);
      }
      shouldRun = await promptConfirm(
        `${chalk.yellow('→')} Automatically execute all ${diagnosis.fixes.length} fix command(s)? (y/N) `,
      );
      if (!shouldRun) process.exit(0);
    }

    const fixSuccess = await executeFixPlan(diagnosis.fixes, cwd);
    if (!fixSuccess) {
      printError('Fix execution stopped due to command failure.');
      process.exit(1);
    }

    const verifyCmd = targetCommand ?? diagnosis.verificationCommand;
    if (verifyCmd) {
      const verifySpinner = ora({
        text: chalk.cyan(`Verifying repair: ${chalk.bold(verifyCmd)}...`),
        spinner: 'dots',
      }).start();

      const verifyResult = await run(verifyCmd, cwd);
      verifySpinner.stop();

      if (verifyResult.exitCode === 0) {
        console.log(chalk.green.bold('\n✔ Verified: Build succeeded! All terminal errors have been resolved.'));
        process.exit(0);
      } else {
        printError(`Verification command still failed (exit code ${verifyResult.exitCode}).`);
        currentError =
          verifyResult.output.trim() ||
          `Command "${verifyCmd}" failed with exit code ${verifyResult.exitCode} without terminal output.`;
      }
    } else {
      console.log(chalk.green.bold('\n✔ All fix steps executed successfully.'));
      process.exit(0);
    }
  }

  printError('Reached maximum autonomous attempts. Some errors still persist.');
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const isPiped = !process.stdin.isTTY && !args.command && !args.paste;

  // --- Step 1: Get error output ---
  let errorOutput: string;

  if (args.command) {
    printInfo(`Running: ${chalk.bold(args.command)}`);
    const result = await run(args.command, cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green('✔ Command succeeded. Nothing to fix.'));
      process.exit(0);
    }
    errorOutput = result.output;
  } else if (args.paste) {
    errorOutput = await readPaste();
  } else if (!process.stdin.isTTY) {
    errorOutput = await readStdin();
  } else {
    console.log(HELP);
    process.exit(0);
  }

  if (!errorOutput.trim()) {
    printError('No error output received.');
    process.exit(1);
  }

  await runDiagnosisAndFix(errorOutput, args.command, args, cwd, isPiped);
}

main().catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
