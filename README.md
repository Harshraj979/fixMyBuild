# fixmybuild

AI-powered build error resolver that runs entirely on your machine using open-source models via [Ollama](https://ollama.com). Pipe a broken build, get the exact fix command. No data leaves your computer.

## Prerequisites

1. Install [Ollama](https://ollama.com)
2. Pull a model:
   ```bash
   ollama pull qwen2.5-coder:7b
   ```

## Install

```bash
npm install -g fixmybuild
```

Or use directly:

```bash
npx fixmybuild "npm run build"
```

## Usage

**Run a command and analyze on failure:**
```bash
fixmybuild "npm run build"
fixmybuild "tsc --noEmit"
fixmybuild "npx vite build"
```

**Pipe error output directly:**
```bash
npm run build 2>&1 | fixmybuild
```

**Paste error output manually:**
```bash
fixmybuild --paste
```

## Options

| Flag | Description |
|---|---|
| `-a, --auto` | Full autonomous repair loop (diagnose -> execute fix plan -> verify -> retry) |
| `-y, --apply` | Automatically run all fix commands in sequence without prompt |
| `-p, --paste` | Paste error output manually from clipboard |
| `--model <name>` | Ollama model to use (default: `qwen2.5-coder:7b`) |
| `-h, --help` | Show help |

**Environment variables:**

| Variable | Description |
|---|---|
| `OLLAMA_HOST` | Ollama server URL (default: `http://127.0.0.1:11434`) |

## How it works

1. Captures build error output (piped, executed, or pasted)
2. Gathers project environment context: `package.json`, `tsconfig.json`, lockfile type (`npm`, `yarn`, `pnpm`, `bun`), Node version, OS, and shell type
3. Sends context to a local open-source model via Ollama
4. Pinpoints the root cause, explains why it happened and why the solution works
5. Generates an ordered, non-interactive sequence of shell commands
6. Autonomously executes the fix commands and re-runs verification until the terminal errors are resolved (when using `--auto` or `--apply`)

All processing happens locally. Zero data sent to external servers.

## Example output

```
⚠  Root Cause
   ESM module imported with require() — chalk v5 is ESM-only but tsconfig targets CommonJS

⚡ Fixes

   1.  SAFE   Set "type": "module" in package.json
      $ npx json -I -f package.json -e 'this.type="module"'

   2.  MODERATE   Downgrade chalk to v4 (last CJS version)
      $ npm install chalk@4

💡 Why
   chalk v5+ ships as ESM-only. Your project uses "type": "commonjs" (or omits it),
   so Node treats .js files as CJS and cannot require() an ESM package.
```

## License

MIT
