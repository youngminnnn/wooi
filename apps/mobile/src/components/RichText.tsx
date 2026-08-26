import { useEffect, useState } from 'react'
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Check, Copy } from 'lucide-react-native'
import { parseMarkdown, type Block, type Span } from '../chat/markdown'
import { useTheme, useThemedStyles } from '../state/theme'
import { useCopy } from '../state/useCopy'
import type { Theme } from '../theme'

/**
 * 본문을 그리는 두 가지 방법.
 *
 * - `RichText` — 마크다운. 에이전트가 **쓴 말**에만 쓴다.
 * - `PlainText` — 코드 울타리만 가리고 나머지는 글자 그대로. 도구가 **뱉은 것**에 쓴다.
 *
 * 이 둘을 가르는 게 요점이다. 도구 출력에 마크다운을 태우면 diff 의 `- removed` 가 글머리표로
 * 바뀌고 셸 주석 `# build` 가 제목이 된다 — 원문을 보려고 펼친 카드가 원문을 안 보여 준다.
 * 데스크톱이 갈라 두는 지점과 같다(ChatPrimitives 의 `AgentMessage` 는 마크다운, `UserMessage`
 * 와 `ErrorRow` 는 `whitespace-pre-wrap`).
 */

/**
 * 한 번에 그릴 본문 길이. 랩탑은 봉투에 들어가는 만큼(수십만 자) 보내 주는데, 그걸 그대로
 * Text 하나에 넣으면 스크롤이 끊긴다. 앞부분만 먼저 그리고 나머지는 눌러서 펼친다 —
 * 자르는 게 아니라 **미루는 것**이라 내용은 그대로 다 있다.
 */
const RENDER_CHARS = 8000

function useDeferredTail(text: string): { shown: string; hidden: number; reveal: () => void } {
  const [expanded, setExpanded] = useState(false)
  const hidden = expanded ? 0 : Math.max(0, text.length - RENDER_CHARS)
  // 서러게이트 쌍 한가운데서 자르면 이모지가 깨진 글자로 남는다.
  const cut = /[\uD800-\uDBFF]/.test(text.charAt(RENDER_CHARS - 1)) ? RENDER_CHARS - 1 : RENDER_CHARS
  return {
    shown: hidden > 0 ? text.slice(0, cut) : text,
    hidden,
    reveal: () => setExpanded(true)
  }
}

function MoreButton({ hidden, onPress }: { hidden: number; onPress: () => void }): React.JSX.Element {
  const styles = useThemedStyles(makeStyles)
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={styles.more}>Show the rest ({hidden.toLocaleString()} more characters)</Text>
    </Pressable>
  )
}

/** 링크는 기본 브라우저로 연다. 열 수 있는 것만 연다 — `javascript:` 같은 것은 링크가 아니다. */
function openLink(href: string): void {
  if (!/^(https?|mailto):/i.test(href)) return
  void Linking.openURL(href).catch(() => undefined)
}

/**
 * 스트리밍 중임을 알리는 커서. 마지막 글자 뒤에 붙는다.
 *
 * 색을 투명으로 바꿔 깜빡인다 — 중첩된 `Text` 의 `opacity` 는 안드로이드에서 믿을 게 못 되고,
 * `Animated` 를 쓰면 네이티브 드라이버를 못 켜서 얻는 것도 없다.
 */
function Caret({ tint }: { tint: string }): React.JSX.Element {
  const [on, setOn] = useState(true)
  useEffect(() => {
    const timer = setInterval(() => setOn((value) => !value), 530)
    return () => clearInterval(timer)
  }, [])
  return <Text style={{ color: on ? tint : 'transparent' }}>▍</Text>
}

function Spans({ spans, tint }: { spans: Span[]; tint: string }): React.JSX.Element {
  const styles = useThemedStyles(makeStyles)
  return (
    <>
      {spans.map((span, index) => {
        const style = [
          span.bold === true && styles.bold,
          span.italic === true && styles.italic,
          span.strike === true && styles.strike,
          span.code === true && styles.inlineCode,
          span.href === undefined ? null : styles.link,
          // 링크·인라인 코드는 자기 색을 갖는다. 나머지는 부모가 정한 색을 따른다.
          span.href === undefined && span.code !== true ? { color: tint } : null
        ]
        if (span.href === undefined) {
          return (
            <Text key={index} style={style}>
              {span.text}
            </Text>
          )
        }
        const href = span.href
        return (
          <Text key={index} style={style} onPress={() => openLink(href)} suppressHighlighting>
            {span.text}
          </Text>
        )
      })}
    </>
  )
}

function CodeBlock({ language, code }: { language: string | null; code: string }): React.JSX.Element {
  const styles = useThemedStyles(makeStyles)
  return (
    <View style={styles.codeBlock}>
      {language !== null ? (
        <View style={styles.codeHead}>
          <Text style={styles.codeLanguage}>{language}</Text>
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.codeScroll}>
        <Text style={styles.code} selectable>
          {code}
        </Text>
      </ScrollView>
    </View>
  )
}

function BlockView({
  block,
  tint,
  trailing
}: {
  block: Block
  tint: string
  /** 블록의 마지막 글자 뒤에 얹을 것(스트리밍 커서). */
  trailing?: React.ReactNode
}): React.JSX.Element {
  const styles = useThemedStyles(makeStyles)
  switch (block.kind) {
    case 'code':
      return <CodeBlock language={block.language} code={block.code} />
    case 'rule':
      return <View style={styles.rule} />
    case 'heading':
      return (
        <Text
          style={[
            styles.heading,
            block.level === 1 ? styles.heading1 : block.level === 2 ? styles.heading2 : styles.heading3,
            { color: tint }
          ]}
          selectable
        >
          <Spans spans={block.spans} tint={tint} />
          {trailing}
        </Text>
      )
    case 'quote':
      return (
        <View style={styles.quote}>
          <Text style={[styles.body, styles.quoteText]} selectable>
            <Spans spans={block.spans} tint={tint} />
            {trailing}
          </Text>
        </View>
      )
    case 'listItem':
      return (
        <View style={[styles.listItem, { paddingLeft: block.depth * 16 }]}>
          <Text style={[styles.body, styles.marker, { color: tint }]}>{block.marker}</Text>
          <Text style={[styles.body, styles.listBody, { color: tint }]} selectable>
            <Spans spans={block.spans} tint={tint} />
            {trailing}
          </Text>
        </View>
      )
    default:
      return (
        <Text style={[styles.body, styles.paragraph, { color: tint }]} selectable>
          <Spans spans={block.spans} tint={tint} />
          {trailing}
        </Text>
      )
  }
}

/** 마크다운 본문. 에이전트가 쓴 말에만 쓴다. */
export function RichText({
  text,
  color,
  streaming = false
}: {
  text: string
  color?: string
  streaming?: boolean
}): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const tint = color ?? theme.text
  const { shown, hidden, reveal } = useDeferredTail(text)
  const blocks = parseMarkdown(shown)
  // 커서는 마지막 **글자** 뒤에 붙어야 한다. 코드 블록 뒤라면 붙일 자리가 없으니 한 줄을 준다.
  const last = blocks[blocks.length - 1]
  const inline = streaming && hidden === 0 && last !== undefined && last.kind !== 'code' && last.kind !== 'rule'

  return (
    <View>
      {blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          tint={tint}
          trailing={inline && index === blocks.length - 1 ? <Caret tint={tint} /> : undefined}
        />
      ))}
      {streaming && !inline && hidden === 0 ? (
        <Text style={[styles.body, { color: tint }]}>
          <Caret tint={tint} />
        </Text>
      ) : null}
      {hidden > 0 ? <MoreButton hidden={hidden} onPress={reveal} /> : null}
    </View>
  )
}

/**
 * 사용자가 친 글. **울타리도 가리지 않는다** — 적은 그대로가 곧 내용이다. 데스크톱
 * `UserMessage` 도 마크다운 없이 `whitespace-pre-wrap` 하나로 그린다.
 *
 * `PlainText` 를 쓰지 않는 이유는 취향이 아니라 **레이아웃 안전**이다. `PlainText` 는 코드
 * 울타리를 만나면 `CodeBlock` 을 만들고 그 안에는 가로 `ScrollView` 가 있는데, 가로
 * ScrollView 는 고유 폭이 무한대다. 말풍선은 `maxWidth` 만 있고 폭이 내용으로 정해지는
 * 컨테이너라, 그 둘이 겹치면 형제인 이 `Text` 의 폭이 0 으로 접힌다 — 글자마다 줄바꿈되어
 * 높이가 폭발하고 폭이 0 이라 아무것도 그려지지 않는다. 실제로 그렇게 터졌다: 폭 제한이
 * 없는 에이전트 쪽(전폭)은 멀쩡하고 말풍선만 빈 회색 덩어리가 됐다.
 *
 * 그러니 **여기에 `PlainText`·`RichText` 를 다시 끼우지 마라.** 꼭 필요하면 말풍선에 확정된
 * 폭을 주는 것이 먼저다.
 */
export function UserText({ text }: { text: string }): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const { shown, hidden, reveal } = useDeferredTail(text)
  return (
    <View>
      <Text style={[styles.body, { color: theme.text }]} selectable>
        {shown}
      </Text>
      {hidden > 0 ? <MoreButton hidden={hidden} onPress={reveal} /> : null}
    </View>
  )
}

/**
 * 글자 그대로. 코드 울타리만 가려 가로 스크롤되는 상자로 만든다 — 도구 출력에는 긴 줄이
 * 흔하고, 그걸 접으면 어느 줄이 어느 줄인지 알 수 없게 된다.
 *
 * **폭이 확정된 컨테이너에서만 쓴다**(전폭 본문·카드). 이유는 `UserText` 주석 참고.
 */
export function PlainText({
  text,
  color,
  compact = false
}: {
  text: string
  color?: string
  /** 카드 안에 든 도구 출력인가. 본문 크기로 그리면 카드 제목(12px)보다 커져 주객이 뒤집힌다. */
  compact?: boolean
}): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const tint = color ?? theme.text
  const { shown, hidden, reveal } = useDeferredTail(text)
  const parts = shown.split(/(```[\s\S]*?```)/g).filter(Boolean)
  const size = compact ? styles.compactBody : styles.body

  return (
    <View>
      {parts.map((part, index) => {
        const fenced = part.startsWith('```') && part.endsWith('```')
        if (!fenced) {
          return (
            <Text key={index} style={[size, { color: tint }]} selectable>
              {part}
            </Text>
          )
        }
        const head = /^```([^\s`]*)/.exec(part)?.[1] ?? ''
        return (
          <CodeBlock
            key={index}
            language={head === '' ? null : head}
            code={part.slice(3, -3).replace(/^[^\n]*\n/, '')}
          />
        )
      })}
      {hidden > 0 ? <MoreButton hidden={hidden} onPress={reveal} /> : null}
    </View>
  )
}

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace' })

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // 폰에서 긴 답변을 읽는 앱이다. 데스크톱의 16px/1.6 을 그대로 가져온다 — 예전 14px 는
    // 같은 글을 읽는 데 눈을 훨씬 많이 쓰게 만든다.
    body: { fontSize: 16, lineHeight: 25 },
    // 데스크톱 `.md p { margin: 0.4em 0 }` 와 같은 값. 목록은 이보다 촘촘해야 한 덩어리로 읽힌다.
    paragraph: { marginVertical: 4 },
    // 도구가 뱉은 것은 읽는 글이 아니라 훑는 글이다. 데스크톱이 같은 자리에 쓰는 크기.
    compactBody: { fontSize: 13.5, lineHeight: 20 },
    bold: { fontWeight: '700' },
    italic: { fontStyle: 'italic' },
    strike: { textDecorationLine: 'line-through' },
    link: { color: theme.info, textDecorationLine: 'underline' },
    inlineCode: {
      backgroundColor: theme.surface2,
      color: theme.text,
      fontFamily: MONO,
      // 0.92em. 고정폭 글꼴은 같은 크기에서 본문보다 커 보인다.
      fontSize: 14.5
    },
    heading: { fontWeight: '600', marginBottom: 2, marginTop: 12 },
    heading1: { fontSize: 20, lineHeight: 27 },
    heading2: { fontSize: 18, lineHeight: 25 },
    heading3: { fontSize: 16.5, lineHeight: 24 },
    listItem: { flexDirection: 'row', marginVertical: 1, paddingRight: 4 },
    // 글머리 열은 고정폭이어야 번호가 두 자리가 돼도 본문 왼쪽이 흔들리지 않는다.
    marker: { color: theme.textDim, minWidth: 22, paddingRight: 6, textAlign: 'right' },
    listBody: { flex: 1 },
    quote: {
      borderLeftColor: theme.border2,
      borderLeftWidth: 3,
      marginVertical: 4,
      paddingLeft: 11
    },
    quoteText: { color: theme.textMuted },
    rule: { backgroundColor: theme.border, height: StyleSheet.hairlineWidth, marginVertical: 12 },
    codeBlock: {
      backgroundColor: theme.bg,
      borderColor: theme.border,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      marginVertical: 7,
      overflow: 'hidden'
    },
    codeHead: {
      alignItems: 'center',
      backgroundColor: theme.bg3,
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 10,
      paddingVertical: 5
    },
    copyButton: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    copyPressed: { opacity: 0.5 },
    copyText: { color: theme.textDim, fontSize: 11, fontWeight: '600' },
    codeLanguage: { color: theme.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
    codeScroll: { padding: 10 },
    code: { color: theme.textMuted, fontFamily: MONO, fontSize: 13, lineHeight: 19 },
    more: { color: theme.accent, fontSize: 13, fontWeight: '600', paddingVertical: 8 }
  })
