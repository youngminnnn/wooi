import { StyleSheet, Text, View } from 'react-native'
import { Cpu, FastForward, Gauge, Pause, Zap } from 'lucide-react-native'
import type { RemoteWorkspace } from '@shared/remote'
import { theme } from '../theme'

/**
 * 컴포저를 감싸는 상태 표시. 데스크톱 Composer 의 `StatusLine`(입력창 위) + 권한 모드
 * 푸터(입력창 아래)와 **같은 값·같은 아이콘·같은 자리**다.
 *
 * 무엇을 보내려는 순간에 보여야 하는 것들이라 헤더가 아니라 여기 있다 — 헤더에 두면
 * 스크롤과 함께 시야에서 사라지고, 정작 필요한 때 보이지 않는다.
 *
 * 라벨은 전부 랩탑이 만들어 보낸다(`workspace.statusLine`). 폰에는 모델 카탈로그도 전역
 * 기본값도 없어서 같은 문구를 스스로 지어낼 수 없다.
 *
 * 아이콘을 쓰는 이유는 폭이다. 폰 한 줄에 "Model: … · Effort: … · Context: …" 를 적으면
 * 정작 값이 잘린다 — 데스크톱이 같은 자리에 쓰는 lucide 아이콘을 그대로 가져오면, 무엇을
 * 말하는 줄인지는 그림이 맡고 글자는 값에만 쓸 수 있다.
 */
export function WorkspaceStatusBar({
  status
}: {
  status: RemoteWorkspace['statusLine']
}): React.JSX.Element | null {
  // 랩탑이 이 필드를 싣기 전 버전이면 아무것도 그리지 않는다 — 자리만 잡고 빈 값을
  // 보여 주면 "모델이 없다"는 다른 말이 된다.
  if (status === null || status === undefined) return null

  return (
    <View style={styles.row}>
      <View style={[styles.item, styles.model]}>
        <Cpu size={11} color={theme.textFaint} />
        <Text style={styles.text} numberOfLines={1}>
          {status.model}
        </Text>
      </View>
      <View style={[styles.item, styles.effort]}>
        <Zap size={11} color={theme.textFaint} />
        <Text style={styles.text} numberOfLines={1}>
          {status.effort}
        </Text>
      </View>
      <ContextMeter context={status.context} compacting={status.compacting} />
    </View>
  )
}

/**
 * 컨텍스트 게이지. 데스크톱과 같은 세 가지 상태를 갖는다 — 압축 중 · 아직 모름 · 사용량.
 *
 * 첫 턴 전에도 자리는 잡고 "—" 로 둔다. 사라졌다 나타나면 그때마다 옆 항목들이 밀린다.
 */
function ContextMeter({
  context,
  compacting
}: {
  context: NonNullable<RemoteWorkspace['statusLine']>['context']
  compacting: boolean
}): React.JSX.Element {
  if (compacting) {
    return (
      <View style={styles.item}>
        <Gauge size={11} color={theme.accent} />
        <Text style={[styles.text, { color: theme.accent }]}>compacting…</Text>
      </View>
    )
  }
  if (context === null) {
    return (
      <View style={styles.item}>
        <Gauge size={11} color={theme.textFaint} />
        <Text style={styles.text}>—</Text>
      </View>
    )
  }

  const pct = Math.min(100, Math.round(context.percentage * 100))
  // 데스크톱과 같은 세 구간: 70% 미만 중립, 70~89% 주의, 90%+ 위험.
  const tone = pct >= 90 ? theme.danger : pct >= 70 ? theme.warning : theme.textDim

  return (
    <View style={styles.item}>
      <Gauge size={11} color={tone} />
      <View style={styles.bar}>
        <View style={[styles.barFill, { backgroundColor: tone, width: `${pct}%` }]} />
      </View>
      <Text style={[styles.text, { color: tone }]}>{pct}%</Text>
    </View>
  )
}

/**
 * 컴포저 아래 권한 모드 배너. 띄울 것이 없는 모드(Claude 의 'default')에서는 데스크톱처럼
 * 아무것도 띄우지 않는다.
 *
 * 데스크톱은 유니코드 기호(⏵⏵ · ⏸)를 쓰는데, 폰에서는 같은 뜻의 lucide 아이콘으로 그린다 —
 * 기호는 기기 폰트에 따라 두부(□)로 떨어지는 일이 있고, 그러면 이 줄이 말하려던 "지금 이
 * 에이전트가 스스로 실행한다"가 통째로 사라진다. 위쪽 상태줄과 같은 세트를 쓰는 이점도 있다.
 */
export function PermissionModeFooter({
  footer
}: {
  footer: NonNullable<RemoteWorkspace['permissionModeFooter']>
}): React.JSX.Element {
  // 색·아이콘은 데스크톱 컴포저와 같은 두 갈래다 — 읽기 전용은 '멈춤'(⏸), 스스로 실행하는
  // 모드는 '빨리 감기'(⏵⏵). 어느 쪽인지는 랩탑이 정해서 보낸다(모드 의미에 달린 판단이다).
  const readOnly = footer.tone === 'readOnly'
  const color = readOnly ? theme.readonly : theme.warning
  const Icon = readOnly ? Pause : FastForward

  return (
    <View style={styles.modeFooter}>
      <Icon size={11} color={color} fill={color} />
      <Text style={[styles.modeText, { color }]} numberOfLines={1}>
        {footer.text}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 6,
    paddingHorizontal: 14
  },
  item: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  // 모델 이름이 가장 길다("Opus 5 (1M context)"). 남는 폭은 여기에 주고, 모자라면 여기서 자른다 —
  // effort·컨텍스트는 짧고 고정폭에 가까워 잘리면 읽을 것이 남지 않는다.
  model: { flexShrink: 1, minWidth: 0 },
  effort: { flexShrink: 1 },
  text: { color: theme.textDim, flexShrink: 1, fontSize: 11 },
  bar: {
    backgroundColor: theme.surface3,
    borderRadius: 2,
    height: 3,
    overflow: 'hidden',
    width: 28
  },
  barFill: { height: '100%' },
  modeFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    paddingBottom: 8,
    paddingHorizontal: 14
  },
  modeText: { fontSize: 11, fontWeight: '600' }
})
