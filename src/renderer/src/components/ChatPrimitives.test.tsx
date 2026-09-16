import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentMessage, extractCodexFollowups, MarkdownBody } from './ChatPrimitives'
import { renderWithStore } from '../test/harness'

describe('Codex follow-up parsing', () => {
  it('removes complete list items and preserves their order and escaped prompts', () => {
    const result = extractCodexFollowups(
      [
        'I can continue with either option.',
        '- :codex-followup[Run tests]{prompt="Run the focused tests"}',
        '- :codex-followup[Explain \\ details]{prompt="Explain \\"this\\" and \\\\that"}'
      ].join('\n')
    )

    expect(result.body).toContain('I can continue with either option.')
    expect(result.body).not.toContain(':codex-followup')
    expect(result.followups).toEqual([
      { label: 'Run tests', prompt: 'Run the focused tests' },
      { label: 'Explain \\ details', prompt: 'Explain "this" and \\that' }
    ])
  })

  it('leaves malformed directives and code samples untouched', () => {
    const source = [
      '- :codex-followup[Missing prompt]{}',
      '`- :codex-followup[Inline]{prompt="keep"}`',
      '```md',
      '- :codex-followup[Fenced]{prompt="keep"}',
      '```',
      '    - :codex-followup[Indented]{prompt="keep"}'
    ].join('\n')

    expect(extractCodexFollowups(source)).toEqual({ body: source, followups: [] })
  })
})

describe('Codex follow-up buttons', () => {
  it('sends the prompt once and blocks duplicate clicks while it is pending', async () => {
    let resolve!: () => void
    const onFollowup = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const user = userEvent.setup()

    renderWithStore(
      <AgentMessage
        text="Done."
        followups={[{ label: 'Continue', prompt: 'Continue with the implementation' }]}
        onFollowup={onFollowup}
      />
    )

    const button = screen.getByRole('button', { name: 'Continue' })
    await user.click(button)
    expect(onFollowup).toHaveBeenCalledOnce()
    expect(onFollowup).toHaveBeenCalledWith('Continue with the implementation')
    expect(button).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeInTheDocument()

    await user.click(button)
    expect(onFollowup).toHaveBeenCalledOnce()

    resolve()
    await waitFor(() => expect(button).toBeEnabled())
  })
})

describe('MarkdownBody math', () => {
  it('renders persisted bracket-delimited display math with KaTeX', () => {
    renderWithStore(
      <MarkdownBody
        text={String.raw`\[
\begin{aligned}
  x &= y + 1 \\
  z &= x - 1
\end{aligned}
\]`}
      />
    )

    expect(document.querySelector('.katex-display')).toBeInTheDocument()
  })

  it('renders inline LaTeX but preserves delimiters in inline and fenced code', () => {
    renderWithStore(
      <MarkdownBody
        text={[
          String.raw`Inline: \(x^2\).`,
          '',
          'Code: `\\(x^2\\)`',
          '',
          '```tex',
          '\\[x^2\\]',
          '```'
        ].join('\n')}
      />
    )

    expect(document.querySelectorAll('.katex')).toHaveLength(1)
    expect(screen.getByText(String.raw`\(x^2\)`)).toBeInTheDocument()
    expect(screen.getByText(String.raw`\[x^2\]`)).toBeInTheDocument()
  })
})
