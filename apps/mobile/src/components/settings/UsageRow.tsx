import { StyleSheet, Text, View } from 'react-native'
import type { RemotePlanWindow } from '@shared/remote'
import { untilLabel } from '../../state/useNow'
import { useTheme, useThemedStyles } from '../../state/theme'
import type { Theme } from '../../theme'

/**
 * 사용률이 이 값을 넘으면 경고색으로 바꾼다(%). 데스크톱 Overview 의 usedTone 과 같은 두 단계다 —
 * 폰만 다른 기준으로 물들면 같은 계정을 두고 두 화면이 서로 다른 위급함을 말하게 된다.
 */
const WARNING_PCT = 75
const DANGER_PCT = 90

function barColor(theme: Theme, usedPct: number): string {
  if (usedPct >= DANGER_PCT) return theme.danger
  if (usedPct >= WARNING_PCT) return theme.warning
  return theme.accent
}

/**
 * 요금제 사용량 창 1개. 값 대신 **막대**를 두는 이유는, 숫자만으로는 "78%" 가 여유인지 위급인지
 * 한눈에 안 읽히기 때문이다(설정 화면은 훑어보는 화면이다).
 */
export function UsageRow({
  usage,
  now
}: {
  usage: RemotePlanWindow
  now: number
}): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  // 이미 지난 리셋 시각은 곧 갱신될 값이라 굳이 보여 주지 않는다(데스크톱 resetLabel 과 같은 규칙).
  const resets =
    usage.resetsAt !== null && usage.resetsAt > now ? untilLabel(usage.resetsAt, now) : null
  return (
    <View style={styles.row}>
      <Text numberOfLines={1} style={styles.label}>
        {usage.label}
      </Text>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { backgroundColor: barColor(theme, usage.usedPct), width: `${usage.usedPct}%` }
          ]}
        />
      </View>
      <Text style={styles.percent}>{usage.usedPct}%</Text>
      <Text style={styles.reset}>{resets === null ? '' : `in ${resets}`}</Text>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 10,
      minHeight: 48,
      paddingHorizontal: 16,
      paddingVertical: 12
    },
    label: { color: theme.text, fontSize: 14.5, width: 92 },
    track: {
      backgroundColor: theme.surface3,
      borderRadius: 3,
      flex: 1,
      height: 5,
      overflow: 'hidden'
    },
    fill: { borderRadius: 3, height: '100%' },
    percent: {
      color: theme.textMuted,
      fontSize: 13,
      fontVariant: ['tabular-nums'],
      textAlign: 'right',
      width: 36
    },
    reset: { color: theme.textFaint, fontSize: 11, textAlign: 'right', width: 46 }
  })
