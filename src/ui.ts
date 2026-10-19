import chalk from 'chalk';
import type { Diagnosis, FixStep } from './analyzer.js';

const RISK_BADGE: Record<FixStep['risk'], string> = {
  safe: chalk.bgGreen.black(' SAFE '),
  moderate: chalk.bgYellow.black(' MODERATE '),
  destructive: chalk.bgRed.white(' DESTRUCTIVE '),
};

export function printDiagnosis(diagnosis: Diagnosis): void {
  console.log();
  console.log(chalk.bold.red('⚠  Root Cause'));
  console.log(`   ${diagnosis.rootCause}`);
  console.log();

  if (diagnosis.fixes.length > 0) {
    console.log(chalk.bold.green('⚡ Fixes'));
    for (let i = 0; i < diagnosis.fixes.length; i++) {
      const fix = diagnosis.fixes[i];
      console.log();
      console.log(`   ${chalk.dim(`${i + 1}.`)} ${RISK_BADGE[fix.risk]}  ${fix.description}`);
      console.log(`      ${chalk.cyan('$')} ${chalk.white.bold(fix.command)}`);
    }
  }

  if (diagnosis.verificationCommand) {
    console.log();
    console.log(chalk.bold.magenta('🔍 Verification'));
    console.log(`      ${chalk.cyan('$')} ${chalk.white.bold(diagnosis.verificationCommand)}`);
  }

  if (diagnosis.explanation) {
    console.log();
    console.log(chalk.bold.blue('💡 Why This Happened & Fix Logic'));
    console.log(`   ${diagnosis.explanation}`);
  }
  console.log();
}

export function printError(message: string): void {
  console.error(`${chalk.red('✖')} ${message}`);
}

export function printInfo(message: string): void {
  console.log(`${chalk.blue('ℹ')} ${message}`);
}
