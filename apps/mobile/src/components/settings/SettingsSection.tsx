import { Children, Fragment, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useThemedStyles } from '../../state/theme'
import type { Theme } from '../../theme'

/**
 * `icon` 은 제목 왼쪽에 붙는 작은 글리프다. 같은 모양의 구역이 여럿일 때(계정별 요금제 사용량)
 * 글자만으로는 어느 것이 어느 계정인지 훑어서 읽히지 않아, 데스크톱 Overview 의 사용량 패널처럼
 * 브랜드 마크로 먼저 구분하게 한다.
 */
export function SettingsSection({
  title,
  icon,
  children
}: {
  title: string
  icon?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const styles = useThemedStyles(makeStyles)
  const rows = Children.toArray(children)
  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        {icon}
        <Text style={styles.title}>{title}</Text>
      </View>
      <View style={styles.card}>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <View style={styles.divider} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    section: { gap: 8 },
    heading: { alignItems: 'center', flexDirection: 'row', gap: 5, paddingHorizontal: 4 },
    title: {
      color: theme.textDim,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.7,
      textTransform: 'uppercase'
    },
    card: {
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: 'hidden'
    },
    divider: { backgroundColor: theme.border, height: StyleSheet.hairlineWidth, marginLeft: 16 }
  })
