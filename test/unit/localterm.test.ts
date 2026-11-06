import { describe, expect, it } from 'vitest'
import { findShells, pickShell } from '../../src/main/localterm'

const fakeEnv = (platform: NodeJS.Platform, files: string[], env: Record<string, string> = {}, etcShells = '') => ({
  platform,
  env,
  exists: (p: string) => files.includes(p),
  read: (p: string) => {
    if (p !== '/etc/shells' || !etcShells) throw new Error('ENOENT')
    return etcShells
  }
})

describe('finding local shells', () => {
  it('lists the Windows shells that are installed, PowerShell 7 first', () => {
    const shells = findShells(
      fakeEnv('win32', [
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'C:\\Windows\\System32\\cmd.exe',
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe'
      ], { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
    )
    expect(shells.map((s) => s.label)).toEqual(['PowerShell 7', 'Windows PowerShell', 'Command Prompt', 'Git Bash'])
    expect(shells.find((s) => s.label === 'Git Bash')!.args).toEqual(['--login', '-i'])
  })

  it('falls back to Windows PowerShell without PowerShell 7', () => {
    const shells = findShells(fakeEnv('win32', ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'], { SystemRoot: 'C:\\Windows' }))
    expect(shells[0]).toMatchObject({ label: 'Windows PowerShell', args: ['-NoLogo'] })
  })

  it('starts with the login shell on macOS and Linux, then /etc/shells', () => {
    const shells = findShells(
      fakeEnv('darwin', ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish'], { SHELL: '/opt/homebrew/bin/fish' }, '# comment\n/bin/bash\n/bin/zsh\n/bin/csh\n')
    )
    expect(shells.map((s) => `${s.label}:${s.path}`)).toEqual(['fish:/opt/homebrew/bin/fish', 'bash:/bin/bash', 'zsh:/bin/zsh'])
    expect(shells.every((s) => s.args[0] === '-l')).toBe(true)
  })

  it('uses the chosen shell while it exists, otherwise the usual one', () => {
    const shells = findShells(fakeEnv('linux', ['/bin/bash', '/usr/bin/zsh'], { SHELL: '/bin/bash' }, '/usr/bin/zsh\n'))
    expect(pickShell('/usr/bin/zsh', shells)!.label).toBe('zsh')
    expect(pickShell('/usr/bin/gone', shells)!.label).toBe('bash')
    expect(pickShell('', shells)!.label).toBe('bash')
    expect(pickShell('', [])).toBeUndefined()
  })
})
