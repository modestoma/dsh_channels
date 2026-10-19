const pattern = /^(feat|fix|docs|test|refactor|chore|ci)(\([a-z0-9][a-z0-9-]*\))?: .+/

/** Validate the conventional subject used by release automation. */
export function assertConventionalSubject(subject, source) {
  if (pattern.test(subject)) return

  console.error(`✗ ${source} must match <type>(<scope>): <summary>`)
  console.error('  type ∈ feat | fix | docs | test | refactor | chore | ci')
  console.error('  scope: dsh-channels (or a module, e.g. feishu, workspaces, cards)')
  console.error(`  got: ${subject || '(empty)'}`)
  process.exit(1)
}
