import { useCallback, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { Check, MessagesSquare } from 'lucide-react-native'
import type { PermissionRequest } from '@shared/types'
import {
  OTHER,
  allAnswered,
  applyOther,
  applyToggle,
  buildAnswers,
  isAnswered,
  parseQuestions,
  type OtherText,
  type Selection
} from '../chat/questions'
import { useRemoteStore } from '../state/store'
import { useDeviceAuthentication } from '../state/useDeviceAuth'
import { useTheme, useThemedStyles } from '../state/theme'
import type { Theme } from '../theme'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong'
}

/**
 * AskUserQuestion 요청을 **선택지 UI** 로 그린다 — 데스크톱 QuestionPrompt 의 폰 판.
 *
 * 이 카드가 따로 있는 이유가 요점이다. 질문을 일반 승인 카드로 그리면 Allow 를 눌러도
 * answers 가 비어 모델이 "사용자가 답하지 않았다" 고 보고 그대로 진행한다 — 폰에서는 질문에
 * 답할 방법이 아예 없었다는 뜻이다. 답은 `updatedInput` 에 실어 되돌린다(랩탑 allowlist 가
 * AskUserQuestion 에만 열어 둔 통로다).
 *
 * 기기 인증은 컴포저의 프롬프트 전송과 **같은 규칙**으로 건다 — 질문에 답하는 것은 도구 실행을
 * 허락하는 게 아니라 에이전트에게 말을 거는 쪽이다. 묻는 모드라면 그 답이 부르는 위험한 일이
 * 전부 권한 프롬프트에 걸리고 그건 이미 인증으로 막혀 있으므로, 여기서 또 묻는 것은 마찰만
 * 늘린다. 묻지 않는 모드(actsWithoutAsking)에서는 답 한 줄이 곧 임의 실행이라 인증을 건다.
 */
export function QuestionCard({
  request,
  command,
  actsWithoutAsking
}: {
  request: PermissionRequest
  command: NonNullable<ReturnType<typeof useRemoteStore.getState>['command']>
  actsWithoutAsking: boolean
}): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const authenticate = useDeviceAuthentication()
  const demo = useRemoteStore((store) => store.demo)

  const questions = useMemo(() => parseQuestions(request.input), [request.input])
  const [selected, setSelected] = useState<Selection>({})
  const [otherText, setOtherText] = useState<OtherText>({})
  const [pending, setPending] = useState<'answer' | 'dismiss' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const responding = pending !== null
  const ready = allAnswered(questions, selected, otherText)

  const toggle = (qi: number, value: string, multi: boolean): void => {
    setSelected((prev) => applyToggle(prev, qi, value, multi))
  }

  const setOther = (qi: number, text: string, multi: boolean): void => {
    setOtherText((prev) => ({ ...prev, [qi]: text }))
    setSelected((prev) => applyOther(prev, qi, text, multi))
  }

  const respond = useCallback(
    async (choice: 'answer' | 'dismiss'): Promise<void> => {
      if (responding) return
      setError(null)
      if (
        !demo &&
        choice === 'answer' &&
        actsWithoutAsking &&
        !(await authenticate('Answer on your laptop'))
      ) {
        setError('Device authentication was cancelled or unsuccessful. Nothing was sent.')
        return
      }
      // 랩탑이 이미 다른 경로로 해소한 요청에 뒤늦게 답하지 않는다(승인 카드와 같은 방어).
      const stillPending = useRemoteStore
        .getState()
        .state?.pendingPermissions.some(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { requestId?: unknown }).requestId === request.requestId
        )
      if (stillPending !== true) return
      setPending(choice)
      const decision =
        choice === 'dismiss'
          ? { behavior: 'deny' as const }
          : {
              behavior: 'allow' as const,
              // 도구 입력을 통째로 되돌려 준다 — answers 만 보내면 질문이 사라진다.
              updatedInput: {
                ...request.input,
                answers: buildAnswers(questions, selected, otherText)
              }
            }
      try {
        await command('permission:respond', [request.requestId, decision])
      } catch (respondError) {
        setError(errorMessage(respondError))
        setPending(null)
      }
    },
    [
      actsWithoutAsking,
      authenticate,
      command,
      demo,
      otherText,
      questions,
      request.input,
      request.requestId,
      responding,
      selected
    ]
  )

  return (
    <View style={styles.card}>
      <View style={styles.heading}>
        <View style={styles.eyebrowRow}>
          <MessagesSquare size={12} color={theme.accent} />
          <Text style={styles.eyebrow}>QUESTION</Text>
        </View>
        {responding ? <ActivityIndicator color={theme.accent} size="small" /> : null}
      </View>

      <ScrollView style={styles.list} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {questions.map((question, qi) => {
          const multi = question.multiSelect === true
          const chosen = selected[qi] ?? []
          return (
            <View
              key={`${qi}-${question.question}`}
              style={qi > 0 ? styles.questionGap : undefined}
            >
              <View style={styles.questionHead}>
                {question.header !== undefined ? (
                  <Text style={styles.chip}>{question.header}</Text>
                ) : null}
                {isAnswered(selected, otherText, qi) ? (
                  <Check size={12} color={theme.success} />
                ) : null}
              </View>
              <Text style={styles.question}>{question.question}</Text>
              {multi ? <Text style={styles.hint}>Choose any that apply</Text> : null}

              {question.options.map((option, oi) => {
                const on = chosen.includes(option.label)
                return (
                  <Pressable
                    key={`${oi}-${option.label}`}
                    style={[styles.option, on && styles.optionOn]}
                    disabled={responding}
                    onPress={() => toggle(qi, option.label, multi)}
                  >
                    <View style={[styles.mark, multi && styles.markSquare, on && styles.markOn]}>
                      {on ? <Check size={11} color={theme.onAccentStrong} /> : null}
                    </View>
                    <View style={styles.optionBody}>
                      <Text style={[styles.optionLabel, on && styles.optionLabelOn]}>
                        {option.label}
                      </Text>
                      {option.description !== undefined && option.description.length > 0 ? (
                        <Text style={styles.optionDescription}>{option.description}</Text>
                      ) : null}
                    </View>
                  </Pressable>
                )
              })}

              {/* Other — 모델이 준 선택지가 답이 아닐 때의 자유 입력. 데스크톱과 같이 항상 있다. */}
              <View style={[styles.option, chosen.includes(OTHER) && styles.optionOn]}>
                <View
                  style={[
                    styles.mark,
                    multi && styles.markSquare,
                    chosen.includes(OTHER) && styles.markOn
                  ]}
                >
                  {chosen.includes(OTHER) ? <Check size={11} color={theme.onAccentStrong} /> : null}
                </View>
                <TextInput
                  style={styles.otherInput}
                  value={otherText[qi] ?? ''}
                  onChangeText={(text) => setOther(qi, text, multi)}
                  editable={!responding}
                  placeholder="Other…"
                  placeholderTextColor={theme.textFaint}
                  multiline
                />
              </View>
            </View>
          )
        })}
      </ScrollView>

      {error !== null ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.actions}>
        <Pressable
          style={[styles.button, responding && styles.disabled]}
          disabled={responding}
          onPress={() => void respond('dismiss')}
        >
          <Text style={styles.dismissText}>{pending === 'dismiss' ? 'Sending…' : 'Dismiss'}</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.answerButton, (!ready || responding) && styles.disabled]}
          disabled={!ready || responding}
          onPress={() => void respond('answer')}
        >
          <Text style={styles.answerText}>{pending === 'answer' ? 'Sending…' : 'Answer'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.surface,
      borderColor: theme.accentStrong,
      borderTopWidth: 2,
      padding: 12
    },
    heading: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between'
    },
    eyebrowRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
    eyebrow: { color: theme.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
    list: { marginTop: 9, maxHeight: 300 },
    questionGap: {
      borderTopColor: theme.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      marginTop: 14,
      paddingTop: 12
    },
    questionHead: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    chip: {
      backgroundColor: theme.bg3,
      borderRadius: 4,
      color: theme.textDim,
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 0.6,
      overflow: 'hidden',
      paddingHorizontal: 6,
      paddingVertical: 3,
      textTransform: 'uppercase'
    },
    question: { color: theme.text, fontSize: 14, fontWeight: '600', lineHeight: 19, marginTop: 6 },
    hint: { color: theme.textFaint, fontSize: 11, marginTop: 3 },
    option: {
      alignItems: 'flex-start',
      backgroundColor: theme.bg2,
      borderColor: theme.surface2,
      borderRadius: 8,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 9,
      marginTop: 7,
      minHeight: 44,
      padding: 10
    },
    optionOn: { backgroundColor: theme.bg3, borderColor: theme.accentStrong },
    mark: {
      alignItems: 'center',
      borderColor: theme.border2,
      borderRadius: 9,
      borderWidth: 1,
      height: 18,
      justifyContent: 'center',
      marginTop: 1,
      width: 18
    },
    markSquare: { borderRadius: 4 },
    markOn: { backgroundColor: theme.accentStrong, borderColor: theme.accentStrong },
    optionBody: { flex: 1 },
    optionLabel: { color: theme.textMuted, fontSize: 13, fontWeight: '600', lineHeight: 18 },
    optionLabelOn: { color: theme.text },
    optionDescription: { color: theme.textDim, fontSize: 11, lineHeight: 16, marginTop: 2 },
    otherInput: {
      color: theme.text,
      flex: 1,
      fontSize: 13,
      lineHeight: 18,
      // 안드로이드 TextInput 은 기본 패딩이 붙어 선택지 라벨과 줄이 어긋난다.
      padding: 0,
      paddingTop: Platform.select({ android: 1, default: 0 })
    },
    error: { color: theme.dangerFg, fontSize: 11, lineHeight: 15, marginTop: 8 },
    actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
    button: {
      alignItems: 'center',
      borderColor: theme.border2,
      borderRadius: 8,
      borderWidth: 1,
      flex: 1,
      justifyContent: 'center',
      minHeight: 44,
      paddingHorizontal: 5
    },
    answerButton: { backgroundColor: theme.accentStrong, borderColor: theme.accentStrong },
    answerText: {
      color: theme.onAccentStrong,
      fontSize: 13,
      fontWeight: '700',
      textAlign: 'center'
    },
    dismissText: { color: theme.textMuted, fontSize: 12, fontWeight: '600', textAlign: 'center' },
    disabled: { opacity: 0.5 }
  })
