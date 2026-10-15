import { describe, expect, it } from 'vitest'
import { parseTarget } from '@shared/target'

describe('parseTarget', () => {
  it('parses user@host:port', () => {
    expect(parseTarget('deploy@example.com:2222')).toEqual({ username: 'deploy', host: 'example.com', port: 2222 })
  })

  it('defaults the port to 22', () => {
    expect(parseTarget('root@10.0.0.5')).toEqual({ username: 'root', host: '10.0.0.5', port: 22 })
  })

  it('accepts a bare host name with a dot', () => {
    expect(parseTarget('  pi.local ')).toEqual({ username: '', host: 'pi.local', port: 22 })
  })

  it('accepts bracketed IPv6 addresses', () => {
    expect(parseTarget('me@[fe80::1]:2200')).toEqual({ username: 'me', host: 'fe80::1', port: 2200 })
  })

  it('rejects plain words and junk', () => {
    expect(parseTarget('production')).toBeNull()
    expect(parseTarget('a b@c.d')).toBeNull()
    expect(parseTarget('')).toBeNull()
  })
})
