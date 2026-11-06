import { useEffect, useState } from 'react'
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-react'

// Matches are marked in the terminal itself; colours must be #RRGGBB.
const DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#7c5e10',
  matchOverviewRuler: '#d9a521',
  activeMatchBackground: '#d97706',
  activeMatchColorOverviewRuler: '#f59e0b'
}

/** Find in the terminal (output and scrollback): Enter / Shift+Enter step through matches. */
export function TerminalFind({ search, onClose }: { search: SearchAddon; onClose(): void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)

  useEffect(() => {
    const sub = search.onDidChangeResults(({ resultIndex, resultCount }) => setResults({ index: resultIndex, count: resultCount }))
    return () => {
      sub.dispose()
      search.clearDecorations()
    }
  }, [search])

  const find = (backwards: boolean, incremental = false): void => {
    if (!query) {
      search.clearDecorations()
      setResults(null)
      return
    }
    const options = { caseSensitive: matchCase, decorations: DECORATIONS }
    if (backwards) search.findPrevious(query, options)
    else search.findNext(query, { ...options, incremental })
  }

  // Typing searches as you go, from the current match on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => find(false, true), [query, matchCase])

  return (
    <div className="term-find" onMouseDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={query}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            find(e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="find-count">
        {results && query ? (results.count ? `${results.index + 1} of ${results.count}` : 'No results') : ''}
      </span>
      <button className={`icon-btn ${matchCase ? 'on' : ''}`} onClick={() => setMatchCase((v) => !v)} title="Match case">
        <CaseSensitive size={15} />
      </button>
      <button className="icon-btn" onClick={() => find(true)} title="Previous (Shift+Enter)">
        <ChevronUp size={15} />
      </button>
      <button className="icon-btn" onClick={() => find(false)} title="Next (Enter)">
        <ChevronDown size={15} />
      </button>
      <button className="icon-btn" onClick={onClose} title="Close (Esc)">
        <X size={15} />
      </button>
    </div>
  )
}
