import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useThemedStyles, useThemeStore } from '../../state/theme'
import type { Theme, ThemePreference } from '../../theme'

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

/**
 * 테마 선택. 데스크톱 설정의 Appearance 와 **같은 세 가지·같은 순서**다.
 *
 * 값을 눌러 들어가는 행이 아니라 세그먼트 컨트롤인 이유: 선택지가 셋뿐이고, 고르는 즉시
 * 화면 전체가 바뀌는 설정이라 결과를 보면서 고를 수 있어야 한다. 하위 화면으로 들어가면
 * 그 확인이 한 번 왕복 뒤로 밀린다.
 */
export function ThemeRow(): React.JSX.Element {
  const styles = useThemedStyles(makeStyles)
  const preference = useThemeStore((store) => store.preference)
  const setPreference = useThemeStore((store) => store.setPreference)

  return (
    <View style={styles.row}>
      <Text style={styles.label}>Theme</Text>
      <View style={styles.segments}>
        {OPTIONS.map((option) => {
          const selected = preference === option.value
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={option.value}
              onPress={() => setPreference(option.value)}
              style={[styles.segment, selected && styles.segmentSelected]}
            >
              <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                {option.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 12,
      minHeight: 48,
      paddingHorizontal: 16,
      paddingVertical: 10
    },
    label: { color: theme.text, flexShrink: 0, fontSize: 14.5 },
    segments: {
      backgroundColor: theme.bg,
      borderRadius: 9,
      flex: 1,
      flexDirection: 'row',
      gap: 2,
      padding: 2
    },
    // 선택 칩은 트랙 위로 **떠 보여야** 한다. 다크에서는 밝은 면이, 라이트에서는 흰 면이
    // 그 역할을 하므로 둘 다 surface 다(라이트에서 surface2 를 쓰면 트랙과 같은 색이 된다).
    // 테두리 폭은 선택 여부와 무관하게 잡아 둔다 — 선택된 칸만 1px 넓어지면 누를 때마다
    // 글자가 흔들린다.
    segment: {
      alignItems: 'center',
      borderColor: 'transparent',
      borderRadius: 7,
      borderWidth: 1,
      flex: 1,
      paddingVertical: 6
    },
    segmentSelected: { backgroundColor: theme.surface, borderColor: theme.border2 },
    segmentText: { color: theme.textDim, fontSize: 13 },
    segmentTextSelected: { color: theme.text, fontWeight: '600' }
  })
