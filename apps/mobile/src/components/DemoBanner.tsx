import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useRemoteStore } from '../state/store'
import { theme } from '../theme'

export function DemoBanner(): React.JSX.Element | null {
  const router = useRouter()
  const demo = useRemoteStore((store) => store.demo)
  const leaveDemo = useRemoteStore((store) => store.leaveDemo)

  if (!demo) return null
  return (
    <View style={styles.banner}>
      <View style={styles.copy}>
        <Text style={styles.title}>DEMO MODE</Text>
        <Text style={styles.body}>Sample data only — nothing is connected to a real laptop.</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        style={styles.button}
        onPress={() => {
          leaveDemo()
          router.replace('/pair')
        }}
      >
        <Text style={styles.buttonText}>Leave demo</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    alignItems: 'center',
    backgroundColor: '#2d2510',
    borderBottomColor: theme.warning,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  copy: { flex: 1 },
  title: { color: theme.warning, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  body: { color: theme.text, fontSize: 12, lineHeight: 17, marginTop: 2 },
  button: {
    borderColor: theme.warning,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  buttonText: { color: theme.warning, fontSize: 11, fontWeight: '700' }
})
