import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AgentMessage,
  extractCodexFollowups,
  extractCodexMessageExtras,
  MarkdownBody
} from './ChatPrimitives'
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

describe('Codex output file citations', () => {
  it('removes complete output directives, retaining their order and decoding escaped paths', () => {
    const result = extractCodexMessageExtras(
      [
        'Saved the requested files.',
        ':codex-file-citation{path="/tmp/first.pdf" purpose="output"}',
        String.raw`:codex-file-citation{path="C:\\work\\second \"copy\".pdf" purpose="output"}`
      ].join('\n')
    )

    expect(result.body).toContain('Saved the requested files.')
    expect(result.body).not.toContain(':codex-file-citation')
    expect(result.fileCitations).toEqual([
      { path: '/tmp/first.pdf' },
      { path: 'C:\\work\\second "copy".pdf' }
    ])
  })

  it('leaves code, malformed, and non-output file directives untouched', () => {
    const source = [
      '` :codex-file-citation{path="/tmp/inline.pdf" purpose="output"}`',
      '```text',
      ':codex-file-citation{path="/tmp/fenced.pdf" purpose="output"}',
      '```',
      '    :codex-file-citation{path="/tmp/indented.pdf" purpose="output"}',
      ':codex-file-citation{path="/tmp/malformed.pdf" purpose=output}',
      ':codex-file-citation{path="/tmp/input.pdf" purpose="input"}'
    ].join('\n')

    expect(extractCodexMessageExtras(source)).toMatchObject({ body: source, fileCitations: [] })
  })

  it('removes one or more output directives appended to prose while retaining the prose', () => {
    const result = extractCodexMessageExtras(
      '완성본: :codex-file-citation{path="/tmp/probability_homework_images.pdf" purpose="output"} :codex-file-citation{path="/tmp/answer-key.pdf" purpose="output"}'
    )

    expect(result.body).toBe('완성본: ')
    expect(result.fileCitations).toEqual([
      { path: '/tmp/probability_homework_images.pdf' },
      { path: '/tmp/answer-key.pdf' }
    ])
  })

  it('keeps standalone citation behavior when Markdown permits up to three leading spaces', () => {
    const result = extractCodexMessageExtras(
      '   :codex-file-citation{path="/tmp/indented-output.pdf" purpose="output"}'
    )

    expect(result.body).toBe('')
    expect(result.fileCitations).toEqual([{ path: '/tmp/indented-output.pdf' }])
  })
})

describe('Codex visualizations', () => {
  it('extracts complete visualize directives and preserves their display metadata', () => {
    const result = extractCodexMessageExtras(
      [
        'Here is the execution trace.',
        'visualize{"path":"/tmp/add-stack-frame.html","title":"add execution","mode":"wide"}',
        'visualize{"path":"/tmp/summary.html"}'
      ].join('\n')
    )

    expect(result.body).toContain('Here is the execution trace.')
    expect(result.body).not.toContain('visualize')
    expect(result.visualizations).toEqual([
      { path: '/tmp/add-stack-frame.html', title: 'add execution', mode: 'wide' },
      { path: '/tmp/summary.html' }
    ])
  })

  it('leaves malformed, unsupported, and code-sample visualize directives untouched', () => {
    const source = [
      'visualize{"path":"/tmp/bad-mode.html","mode":"compact"}',
      'visualize{"path":42}',
      'visualize{"path":"/tmp/unknown.html","theme":"dark"}',
      '`visualize{"path":"/tmp/inline.html"}`',
      '```text',
      'visualize{"path":"/tmp/fenced.html"}',
      '```',
      '    visualize{"path":"/tmp/indented.html"}'
    ].join('\n')

    expect(extractCodexMessageExtras(source)).toMatchObject({ body: source, visualizations: [] })
  })

  it('does not close a long fence with a shorter or annotated fence', () => {
    const source = [
      '````text',
      '```',
      '````not-a-close',
      'visualize{"path":"/tmp/still-code.html"}',
      '````'
    ].join('\n')
    expect(extractCodexMessageExtras(source)).toMatchObject({ body: source, visualizations: [] })
  })
})

describe('Codex follow-up buttons', () => {
  it('shows a visualization card without injecting its HTML', () => {
    renderWithStore(
      <AgentMessage
        text="Done."
        visualizations={[
          {
            path: '/Users/youngmin/wooi/workspaces/snu/punchy-octopus/visualizations/add-stack-frame.html',
            title: 'add 실행 중 %rsp·%rbp 변화',
            mode: 'wide'
          }
        ]}
      />
    )

    expect(screen.getByLabelText('Visualizations')).toBeInTheDocument()
    expect(screen.getByText('add 실행 중 %rsp·%rbp 변화')).toBeInTheDocument()
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument()
    expect(document.querySelector('iframe')).not.toBeInTheDocument()
  })

  it('shows output file chips alongside follow-up buttons', () => {
    renderWithStore(
      <AgentMessage
        text="Done."
        followups={[{ label: 'Continue', prompt: 'Continue with the implementation' }]}
        fileCitations={[{ path: '/Users/youngmin/output/probability_homework_images.pdf' }]}
        onFollowup={async () => undefined}
      />
    )

    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    expect(screen.getByLabelText('Output files')).toBeInTheDocument()
    const chip = screen.getByText('probability_homework_images.pdf')
    expect(chip.parentElement).toHaveAttribute(
      'title',
      '/Users/youngmin/output/probability_homework_images.pdf'
    )
  })

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
