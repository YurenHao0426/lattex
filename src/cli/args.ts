// CLI argument parser

export interface ParsedArgs {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2)
  let command = ''
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  // The command is the first non-flag token, so `lattex-cli --help` and
  // `lattex-cli --json projects` both work.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-h') {
      flags.help = true
    } else if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        const key = arg.slice(2)
        // Boolean flags that never take a value
        const boolFlags = new Set(['json', 'dry-run', 'delete', 'force', 'help'])
        if (boolFlags.has(key)) {
          flags[key] = true
        } else {
          flags[key] = args[++i]
        }
      } else {
        flags[arg.slice(2)] = true
      }
    } else if (!command) {
      command = arg
    } else {
      positional.push(arg)
    }
  }

  return { command, positional, flags }
}
