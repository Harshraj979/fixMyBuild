import { Ollama } from 'ollama';
import type { ProjectContext } from './context.js';

export interface FixStep {
  command: string;
  description: string;
  risk: 'safe' | 'moderate' | 'destructive';
}

export interface Diagnosis {
  rootCause: string;
  fixes: FixStep[];
  explanation: string;
  verificationCommand?: string;
}

const SYSTEM_PROMPT = `You are an autonomous terminal error repair and build self-healing engine. You receive terminal output from a failed build/install/runtime command plus project environment context.

Your mission:
1. Pinpoint the EXACT root cause of the terminal failure.
2. Formulate a comprehensive explanation: why this error occurred and how the fix resolves it.
3. Generate an EXACT, non-interactive sequence of shell commands to be executed automatically by the runner to completely resolve the errors.

Rules:
- Root cause: Identify the single underlying issue breaking the build or terminal command.
- Ordered Fix Plan: The "fixes" array MUST contain commands in the exact sequential order they need to be executed.
- Autonomous & Non-interactive: Commands will be executed automatically without human intervention. Never output commands that hang or prompt interactively for input (use non-interactive flags like --yes, -y, or --force only when necessary).
- Platform-Aware: Commands must strictly match the target OS, shell, and package manager specified in the environment context (e.g., Windows cmd/PowerShell vs Linux/macOS bash; npm vs yarn vs pnpm vs bun).
- Subshell Independence: Each fix command runs in a separate child process. Do NOT output isolated "cd <dir>" commands as separate steps (combine with "cd <dir> && <cmd>" or use "--prefix <dir>").
- Risk Classification:
  * "safe" = installs missing packages, creates missing files, fixes permissions, adds scripts
  * "moderate" = clears caches, updates lockfiles, regenerates build artifacts
  * "destructive" = deletes node_modules, switches runtime/engine versions, resets git state
- Verification: Provide a verificationCommand (e.g. the original command or build script) to automatically verify the repair.
- Output Format: Strictly output valid JSON matching the exact schema below. No conversational filler, markdown fences, preamble, or apologies.

Respond ONLY in valid JSON matching this exact schema:
{
  "rootCause": "precise, single sentence identifying the exact failure mechanism",
  "explanation": "2-3 clear sentences explaining why this happened in this environment and how these commands fix it",
  "fixes": [
    {
      "command": "exact non-interactive shell command to execute",
      "description": "what this specific step does in 10 words or less",
      "risk": "safe|moderate|destructive"
    }
  ],
  "verificationCommand": "shell command to run afterwards to verify all errors are resolved"
}`;

function stripAnsi(text: string): string {
  // Strips ANSI escape codes / color formatting from terminal output
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g,
    '',
  );
}

function truncateOutput(output: string, maxLen = 4000): string {
  const clean = stripAnsi(output).trim();
  if (clean.length <= maxLen) return clean;
  const headLen = Math.floor(maxLen * 0.3);
  const tailLen = maxLen - headLen;
  return (
    clean.slice(0, headLen) +
    '\n\n... (truncated) ...\n\n' +
    clean.slice(-tailLen)
  );
}

function buildPrompt(errorOutput: string, ctx: ProjectContext): string {
  const pmInfo = ctx.packageManagerVersion ?? ctx.lockfileType ?? 'unknown';
  let prompt = `## Build Error Output\n\`\`\`\n${truncateOutput(errorOutput)}\n\`\`\`\n\n## Environment\n- Node: ${ctx.nodeVersion}\n- npm: ${ctx.npmVersion}\n- Active Package Manager: ${pmInfo}\n- OS: ${ctx.os} (${ctx.arch})`;

  if (ctx.packageJson) {
    try {
      const pkg = JSON.parse(ctx.packageJson);
      const allDeps: Record<string, string> = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      const entries = Object.entries(allDeps);
      const depList = entries
        .slice(0, 40)
        .map(([k, v]) => `${k}@${v}`)
        .join(', ');
      const suffix = entries.length > 40 ? ` ... and ${entries.length - 40} more` : '';
      prompt += `\n- Scripts: ${JSON.stringify(pkg.scripts ?? {})}`;
      prompt += `\n- Dependencies: ${depList}${suffix}`;
      if (pkg.engines) prompt += `\n- Engines: ${JSON.stringify(pkg.engines)}`;
    } catch {
      // malformed package.json — still proceed
    }
  }

  if (ctx.tsconfig) {
    prompt += `\n\n## tsconfig.json\n\`\`\`json\n${ctx.tsconfig.slice(0, 1200)}\n\`\`\``;
  }

  if (ctx.nvmrc) {
    prompt += `\n\n## .nvmrc\n${ctx.nvmrc.trim()}`;
  }

  const shellType = process.platform === 'win32' ? 'Windows cmd / PowerShell' : 'Unix sh / bash';
  prompt += `\n- Expected Shell: ${shellType}`;
  prompt +=
    '\n\nDiagnose the root cause, provide a clear explanation of why this happened and how the fix works, and provide exact, sequential non-interactive fix commands. Respond ONLY in JSON matching the schema.';
  return prompt;
}

const VALID_RISKS = new Set(['safe', 'moderate', 'destructive']);

function extractJson(text: string): string {
  // Strip reasoning/thought tags if present (e.g. DeepSeek-R1 / Qwen)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // If wrapped in markdown code fence anywhere
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // If there's still text around the json object, slice from first '{' to last '}'
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return cleaned.slice(start, end + 1);
  }

  return cleaned;
}

export async function analyze(
  errorOutput: string,
  context: ProjectContext,
  model: string,
): Promise<Diagnosis> {
  const host = process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';
  const ollama = new Ollama({ host });

  const response = await ollama.chat({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(errorOutput, context) },
    ],
    format: 'json',
    options: { temperature: 0.1, num_predict: 2048 },
  });

  const raw = response.message.content.trim();
  const jsonStr = extractJson(raw);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      'Model returned invalid JSON. Try a different model with --model',
    );
  }

  return {
    rootCause: String(parsed['rootCause'] ?? 'Unable to determine root cause'),
    fixes: Array.isArray(parsed['fixes'])
      ? parsed['fixes'].map((f: Record<string, unknown>) => ({
          command: String(f['command'] ?? ''),
          description: String(f['description'] ?? ''),
          risk: (VALID_RISKS.has(f['risk'] as string)
            ? f['risk']
            : 'moderate') as FixStep['risk'],
        }))
      : [],
    explanation: String(parsed['explanation'] ?? ''),
    verificationCommand: parsed['verificationCommand']
      ? String(parsed['verificationCommand'])
      : undefined,
  };
}
