import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { theme } from '../../theme'

interface SettingsRowProps {
  label: string
  value?: string
  accessory?: 'chevron' | 'none'
  onPress?: () => void
  destructive?: boolean
  disabled?: boolean
  loading?: boolean
}

export function SettingsRow({
  label,
  value,
  accessory = 'none',
  onPress,
  destructive = false,
  disabled = false,
  loading = false
}: SettingsRowProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole={onPress === undefined ? undefined : 'button'}
      disabled={disabled || onPress === undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && !disabled && styles.pressed]}
    >
      <Text style={[styles.label, destructive && styles.destructive, disabled && styles.disabled]}>
        {label}
      </Text>
      <View style={styles.trailing}>
        {value !== undefined ? (
          <Text numberOfLines={1} style={styles.value}>
            {value}
          </Text>
        ) : null}
        {loading ? <ActivityIndicator color={theme.textDim} size="small" /> : null}
        {!loading && accessory === 'chevron' ? (
          <ChevronRight color={theme.textFaint} size={17} strokeWidth={1.8} />
        ) : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12
  },
  pressed: { backgroundColor: theme.surface2 },
  label: { color: theme.text, flexShrink: 0, fontSize: 14.5 },
  destructive: { color: theme.danger },
  disabled: { opacity: 0.55 },
  trailing: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 7, justifyContent: 'flex-end' },
  value: { color: theme.textDim, flexShrink: 1, fontSize: 13, marginLeft: 16, textAlign: 'right' }
})
