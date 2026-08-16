import { Children, Fragment, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'

export function SettingsSection({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  const rows = Children.toArray(children)
  return (
    <View style={styles.section}>
      <Text style={styles.title}>{title}</Text>
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

const styles = StyleSheet.create({
  section: { gap: 8 },
  title: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.7,
    paddingHorizontal: 4,
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
