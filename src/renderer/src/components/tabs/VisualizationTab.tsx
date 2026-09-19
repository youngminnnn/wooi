import Composer from '../Composer'
import { useHostedView } from '../../lib/hostedView'
import type { Workspace, WorkspaceTab } from '@shared/types'

/**
 * Codex가 만든 HTML visualization 전용 탭.
 *
 * 주소는 main이 워크스페이스 안의 일반 HTML인지 확인한 뒤 발급한 opaque URL이다. renderer는
 * 원래 경로나 HTML을 읽지 않고, artifact와 같은 격리된 hosted-view 자리만 제공한다.
 */
export default function VisualizationTab({
  workspace,
  tab
}: {
  workspace: Workspace
  tab: WorkspaceTab
}): React.JSX.Element {
  const { ref, failure } = useHostedView({
    tabId: tab.id,
    workspaceId: workspace.id,
    kind: 'visualization',
    initialUrl: tab.target
  })

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div className="relative flex-1 min-h-0 bg-white">
        <div ref={ref} data-hosted-view={tab.id} className="absolute inset-0" />
        {failure && (
          <div className="absolute inset-0 grid place-items-center bg-[var(--bg)] p-6 text-center">
            <div>
              <p className="text-sm font-medium text-neutral-200">Could not open visualization</p>
              <p className="mt-1 max-w-lg text-sm text-neutral-500">{failure}</p>
            </div>
          </div>
        )}
      </div>
      <Composer workspace={workspace} />
    </div>
  )
}
