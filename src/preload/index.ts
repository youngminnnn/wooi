import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '@shared/types'
import type { WooiApi } from '@shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener as never)
  return () => ipcRenderer.removeListener(channel, listener as never)
}

const api: WooiApi = {
  getState: () => ipcRenderer.invoke(IPC.appGetState),

  repo: {
    add: () => ipcRenderer.invoke(IPC.repoAdd),
    update: (repoId, patch) => ipcRenderer.invoke(IPC.repoUpdate, repoId, patch),
    adoptCarrySuggestions: (repoId, workspaceId) =>
      ipcRenderer.invoke(IPC.repoAdoptCarry, repoId, workspaceId),
    remove: (repoId) => ipcRenderer.invoke(IPC.repoRemove, repoId),
    reorder: (repoId, targetRepoId, position) =>
      ipcRenderer.invoke(IPC.repoReorder, repoId, targetRepoId, position),
    listBranches: (repoId) => ipcRenderer.invoke(IPC.repoListBranches, repoId),
    listIssues: (repoId) => ipcRenderer.invoke(IPC.repoListIssues, repoId),
    getIssueBody: (repoId, number) => ipcRenderer.invoke(IPC.repoGetIssueBody, repoId, number)
  },

  workspace: {
    create: (args) => ipcRenderer.invoke(IPC.workspaceCreate, args),
    archive: (workspaceId) => ipcRenderer.invoke(IPC.workspaceArchive, workspaceId),
    dismissArchiveSuggest: (workspaceId) =>
      ipcRenderer.invoke(IPC.workspaceArchiveSuggestDismiss, workspaceId),
    unarchive: (workspaceId) => ipcRenderer.invoke(IPC.workspaceUnarchive, workspaceId),
    restack: (workspaceId) => ipcRenderer.invoke(IPC.workspaceRestack, workspaceId),
    switchBranch: (workspaceId, branch) =>
      ipcRenderer.invoke(IPC.workspaceSwitchBranch, workspaceId, branch),
    remove: (workspaceId, deleteBranch) =>
      ipcRenderer.invoke(IPC.workspaceRemove, workspaceId, deleteBranch),
    removeArchived: (repoId) => ipcRenderer.invoke(IPC.workspaceRemoveArchived, repoId),
    deliverPeerMessage: (workspaceId, messageId) =>
      ipcRenderer.invoke(IPC.workspacePeerInboxDeliver, workspaceId, messageId),
    dismissPeerMessage: (workspaceId, messageId) =>
      ipcRenderer.invoke(IPC.workspacePeerInboxDismiss, workspaceId, messageId),
    setPeerInbound: (workspaceId, policy) =>
      ipcRenderer.invoke(IPC.workspaceSetPeerInbound, workspaceId, policy),
    setPermissionMode: (workspaceId, mode) =>
      ipcRenderer.invoke(IPC.workspaceSetPermissionMode, workspaceId, mode),
    setModel: (workspaceId, model) => ipcRenderer.invoke(IPC.workspaceSetModel, workspaceId, model),
    setEffort: (workspaceId, effort) =>
      ipcRenderer.invoke(IPC.workspaceSetEffort, workspaceId, effort),
    setFastMode: (workspaceId, fastMode) =>
      ipcRenderer.invoke(IPC.workspaceSetFastMode, workspaceId, fastMode),
    setAgentBackend: (workspaceId, agentBackend, opts) =>
      ipcRenderer.invoke(IPC.workspaceSetAgentBackend, workspaceId, agentBackend, opts),
    setMuted: (workspaceId, muted) => ipcRenderer.invoke(IPC.workspaceSetMuted, workspaceId, muted),
    setMultiAgent: (workspaceId, multiAgent) =>
      ipcRenderer.invoke(IPC.workspaceSetMultiAgent, workspaceId, multiAgent),
    rename: (workspaceId, name) => ipcRenderer.invoke(IPC.workspaceRename, workspaceId, name),
    reorder: (workspaceId, targetWorkspaceId, position) =>
      ipcRenderer.invoke(IPC.workspaceReorder, workspaceId, targetWorkspaceId, position),
    revealInFinder: (workspaceId) => ipcRenderer.invoke(IPC.workspaceRevealInFinder, workspaceId),
    openInEditor: (workspaceId) => ipcRenderer.invoke(IPC.workspaceOpenInEditor, workspaceId),
    openMemory: (workspaceId) => ipcRenderer.invoke(IPC.workspaceOpenMemory, workspaceId),
    addMemory: (workspaceId, scope, text) =>
      ipcRenderer.invoke(IPC.workspaceAddMemory, workspaceId, scope, text),
    addDir: (workspaceId, dir) => ipcRenderer.invoke(IPC.workspaceAddDir, workspaceId, dir)
  },

  fanout: {
    create: (args) => ipcRenderer.invoke(IPC.fanoutCreate, args),
    adopt: (groupId, workspaceId) => ipcRenderer.invoke(IPC.fanoutAdopt, groupId, workspaceId),
    forget: (groupId) => ipcRenderer.invoke(IPC.fanoutForget, groupId)
  },

  chat: {
    send: (workspaceId, text, images) =>
      ipcRenderer.invoke(IPC.chatSend, workspaceId, text, images),
    interrupt: (workspaceId) => ipcRenderer.invoke(IPC.chatInterrupt, workspaceId),
    getHistory: (workspaceId) => ipcRenderer.invoke(IPC.chatGetHistory, workspaceId),
    getCosts: () => ipcRenderer.invoke(IPC.chatGetCosts),
    sideQuestion: (workspaceId, question) =>
      ipcRenderer.invoke(IPC.chatSideQuestion, workspaceId, question),
    clear: (workspaceId) => ipcRenderer.invoke(IPC.chatClear, workspaceId),
    search: (query, opts) => ipcRenderer.invoke(IPC.chatSearch, query, opts)
  },

  permission: {
    respond: (requestId, decision) => ipcRenderer.invoke(IPC.permissionRespond, requestId, decision)
  },

  script: {
    run: (workspaceId, kind) => ipcRenderer.invoke(IPC.scriptRun, workspaceId, kind),
    stop: (workspaceId, kind) => ipcRenderer.invoke(IPC.scriptStop, workspaceId, kind),
    getStatus: (workspaceId) => ipcRenderer.invoke(IPC.scriptGetStatus, workspaceId),
    getOutput: (workspaceId, kind) => ipcRenderer.invoke(IPC.scriptGetOutput, workspaceId, kind)
  },

  preview: {
    setUrl: (workspaceId, url) => ipcRenderer.invoke(IPC.previewSetUrl, workspaceId, url),
    open: (workspaceId, url) => ipcRenderer.invoke(IPC.previewOpen, workspaceId, url),
    capture: (workspaceId, webContentsId) =>
      ipcRenderer.invoke(IPC.previewCapture, workspaceId, webContentsId),
    pickElement: (workspaceId, webContentsId) =>
      ipcRenderer.invoke(IPC.previewPickElement, workspaceId, webContentsId),
    cancelPick: (webContentsId) => ipcRenderer.invoke(IPC.previewCancelPick, webContentsId),
    watchIssues: (workspaceId, webContentsId) =>
      ipcRenderer.invoke(IPC.previewWatchIssues, workspaceId, webContentsId),
    unwatchIssues: (webContentsId) => ipcRenderer.invoke(IPC.previewUnwatchIssues, webContentsId),
    listIssues: (workspaceId) => ipcRenderer.invoke(IPC.previewListIssues, workspaceId),
    clearIssues: (workspaceId) => ipcRenderer.invoke(IPC.previewClearIssues, workspaceId),
    sendIssues: (workspaceId, issueIds) =>
      ipcRenderer.invoke(IPC.previewSendIssues, workspaceId, issueIds),
    onOpen: (cb) => subscribe(IPC.evtPreviewOpen, cb),
    onIssues: (cb) => subscribe(IPC.evtPreviewIssues, cb)
  },

  git: {
    status: (workspaceId) => ipcRenderer.invoke(IPC.gitStatus, workspaceId),
    diff: (workspaceId) => ipcRenderer.invoke(IPC.gitDiff, workspaceId),
    updateFromBase: (workspaceId) => ipcRenderer.invoke(IPC.gitUpdateFromBase, workspaceId),
    abortMerge: (workspaceId) => ipcRenderer.invoke(IPC.gitAbortMerge, workspaceId)
  },

  pr: {
    status: (workspaceId) => ipcRenderer.invoke(IPC.prStatus, workspaceId),
    statusForBranch: (workspaceId, branch) =>
      ipcRenderer.invoke(IPC.prStatusForBranch, workspaceId, branch),
    create: (workspaceId, branch) => ipcRenderer.invoke(IPC.prCreate, workspaceId, branch),
    merge: (workspaceId, method) => ipcRenderer.invoke(IPC.prMerge, workspaceId, method),
    close: (workspaceId) => ipcRenderer.invoke(IPC.prClose, workspaceId),
    reopen: (workspaceId) => ipcRenderer.invoke(IPC.prReopen, workspaceId),
    ready: (workspaceId) => ipcRenderer.invoke(IPC.prReady, workspaceId),
    editable: (workspaceId) => ipcRenderer.invoke(IPC.prEditable, workspaceId),
    edit: (workspaceId, edits) => ipcRenderer.invoke(IPC.prEdit, workspaceId, edits),
    checks: (workspaceId) => ipcRenderer.invoke(IPC.prChecks, workspaceId)
  },

  stack: {
    syncApply: (workspaceId) => ipcRenderer.invoke(IPC.stackSyncApply, workspaceId),
    syncDismiss: (workspaceId) => ipcRenderer.invoke(IPC.stackSyncDismiss, workspaceId),
    baseRetarget: (workspaceId) => ipcRenderer.invoke(IPC.stackBaseRetarget, workspaceId),
    baseKeep: (workspaceId) => ipcRenderer.invoke(IPC.stackBaseKeep, workspaceId)
  },

  review: {
    listOpenPrs: (repoId) => ipcRenderer.invoke(IPC.reviewListOpenPrs, repoId),
    resolveStack: (repoId, prNumber) =>
      ipcRenderer.invoke(IPC.reviewResolveStack, repoId, prNumber),
    start: (args) => ipcRenderer.invoke(IPC.reviewStart, args),
    cancel: (reviewId) => ipcRenderer.invoke(IPC.reviewCancel, reviewId),
    post: (reviewId, findingId, body) =>
      ipcRenderer.invoke(IPC.reviewPost, reviewId, findingId, body),
    dismiss: (reviewId, findingId) => ipcRenderer.invoke(IPC.reviewDismiss, reviewId, findingId),
    close: (reviewId) => ipcRenderer.invoke(IPC.reviewClose, reviewId),
    load: (reviewId) => ipcRenderer.invoke(IPC.reviewLoad, reviewId),
    setFileViewed: (reviewId, path, viewed, prNumber) =>
      ipcRenderer.invoke(IPC.reviewSetFileViewed, reviewId, path, viewed, prNumber),
    archive: (reviewId) => ipcRenderer.invoke(IPC.reviewArchive, reviewId),
    unarchive: (reviewId) => ipcRenderer.invoke(IPC.reviewUnarchive, reviewId),
    submit: (reviewId, entries) => ipcRenderer.invoke(IPC.reviewSubmit, reviewId, entries),
    poll: (reviewId) => ipcRenderer.invoke(IPC.reviewPoll, reviewId),
    markSeen: (reviewId) => ipcRenderer.invoke(IPC.reviewMarkSeen, reviewId),
    reply: (reviewId, commentId, body) =>
      ipcRenderer.invoke(IPC.reviewReply, reviewId, commentId, body),
    followUp: (reviewId, text) => ipcRenderer.invoke(IPC.reviewFollowUp, reviewId, text)
  },

  fs: {
    list: (workspaceId, relPath) => ipcRenderer.invoke(IPC.fsList, workspaceId, relPath),
    read: (workspaceId, relPath) => ipcRenderer.invoke(IPC.fsRead, workspaceId, relPath),
    search: (workspaceId, query) => ipcRenderer.invoke(IPC.fsSearch, workspaceId, query)
  },

  agent: {
    listBackends: () => ipcRenderer.invoke(IPC.agentListBackends),
    listModels: (backendId) => ipcRenderer.invoke(IPC.agentListModels, backendId)
  },

  commands: {
    list: (workspaceId) => ipcRenderer.invoke(IPC.commandsList, workspaceId),
    run: (workspaceId, kind) => ipcRenderer.invoke(IPC.commandRun, workspaceId, kind),
    mcpAction: (workspaceId, serverName, action) =>
      ipcRenderer.invoke(IPC.mcpAction, workspaceId, serverName, action),
    rewindAction: (workspaceId, userMessageId) =>
      ipcRenderer.invoke(IPC.commandRewindAction, workspaceId, userMessageId),
    wooiRun: (workspaceId, name, rest) =>
      ipcRenderer.invoke(IPC.wooiCommandRun, workspaceId, name, rest)
  },

  rateLimits: {
    refresh: (agentId) => ipcRenderer.invoke(IPC.rateLimitsRefresh, agentId)
  },

  terminal: {
    start: (workspaceId, terminalId, cols, rows) =>
      ipcRenderer.invoke(IPC.terminalStart, workspaceId, terminalId, cols, rows),
    input: (workspaceId, terminalId, data) =>
      ipcRenderer.invoke(IPC.terminalInput, workspaceId, terminalId, data),
    runCommand: (workspaceId, command) =>
      ipcRenderer.invoke(IPC.terminalRunCommand, workspaceId, command),
    exec: (workspaceId, command) => ipcRenderer.invoke(IPC.terminalExec, workspaceId, command),
    killInline: (workspaceId, itemId) =>
      ipcRenderer.invoke(IPC.terminalKillInline, workspaceId, itemId),
    resize: (workspaceId, terminalId, cols, rows) =>
      ipcRenderer.invoke(IPC.terminalResize, workspaceId, terminalId, cols, rows),
    kill: (workspaceId) => ipcRenderer.invoke(IPC.terminalKill, workspaceId),
    tabs: (workspaceId) => ipcRenderer.invoke(IPC.terminalTabs, workspaceId),
    createTab: (workspaceId) => ipcRenderer.invoke(IPC.terminalTabCreate, workspaceId),
    closeTab: (workspaceId, terminalId) =>
      ipcRenderer.invoke(IPC.terminalTabClose, workspaceId, terminalId),
    renameTab: (workspaceId, terminalId, title) =>
      ipcRenderer.invoke(IPC.terminalTabRename, workspaceId, terminalId, title),
    selectTab: (workspaceId, terminalId) =>
      ipcRenderer.invoke(IPC.terminalTabSelect, workspaceId, terminalId),
    onData: (cb) => subscribe(IPC.evtTerminalData, cb),
    onExit: (cb) => subscribe(IPC.evtTerminalExit, cb),
    onTabs: (cb) => subscribe(IPC.evtTerminalTabs, cb)
  },

  pane: {
    open: (kind, workspaceId) => ipcRenderer.invoke(IPC.paneOpen, kind, workspaceId),
    close: (kind) => ipcRenderer.invoke(IPC.paneClose, kind),
    focus: (kind) => ipcRenderer.invoke(IPC.paneFocus, kind),
    getState: () => ipcRenderer.invoke(IPC.paneGetState),
    setWorkspace: (workspaceId) => ipcRenderer.invoke(IPC.paneSetWorkspace, workspaceId),
    openRepoSettings: (repoId) => ipcRenderer.invoke(IPC.paneOpenRepoSettings, repoId),
    onState: (cb) => subscribe(IPC.evtPaneState, cb),
    onWorkspace: (cb) => subscribe(IPC.evtPaneWorkspace, cb)
  },

  app: {
    setBadgeCount: (count) => ipcRenderer.invoke(IPC.appSetBadge, count),
    getVersion: () => ipcRenderer.invoke(IPC.appGetVersion)
  },

  update: {
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    getStatus: () => ipcRenderer.invoke(IPC.updateGetStatus),
    quitAndInstall: () => ipcRenderer.invoke(IPC.updateQuitAndInstall),
    setRestartWhenIdle: (armed) => ipcRenderer.invoke(IPC.updateSetRestartWhenIdle, armed)
  },

  notice: {
    getActive: () => ipcRenderer.invoke(IPC.noticeGetActive),
    refresh: () => ipcRenderer.invoke(IPC.noticeRefresh)
  },

  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),

  settings: {
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch)
  },

  mcp: {
    inventory: () => ipcRenderer.invoke(IPC.mcpInventory),
    openConfig: () => ipcRenderer.invoke(IPC.mcpOpenConfig),
    codexServers: () => ipcRenderer.invoke(IPC.mcpCodexList),
    setCodexServerEnabled: (name, enabled) =>
      ipcRenderer.invoke(IPC.mcpCodexSetEnabled, name, enabled)
  },

  auth: {
    getStatus: () => ipcRenderer.invoke(IPC.authGetStatus),
    claudeLoginStart: () => ipcRenderer.invoke(IPC.authClaudeLoginStart),
    claudeLoginSubmitCode: (code) => ipcRenderer.invoke(IPC.authClaudeLoginSubmitCode, code),
    claudeLoginCancel: () => ipcRenderer.invoke(IPC.authClaudeLoginCancel),
    claudeLogout: () => ipcRenderer.invoke(IPC.authClaudeLogout),
    codexLoginStart: (method, apiKey) =>
      ipcRenderer.invoke(IPC.authCodexLoginStart, method, apiKey),
    codexLoginCancel: () => ipcRenderer.invoke(IPC.authCodexLoginCancel),
    codexLogout: () => ipcRenderer.invoke(IPC.authCodexLogout),
    codexRateLimits: () => ipcRenderer.invoke(IPC.authCodexRateLimits),
    githubLoginStart: () => ipcRenderer.invoke(IPC.authGithubLoginStart),
    githubLoginCancel: () => ipcRenderer.invoke(IPC.authGithubLoginCancel),
    githubLogout: () => ipcRenderer.invoke(IPC.authGithubLogout)
  },

  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  onChat: (cb) => subscribe(IPC.evtChat, cb),
  onSideQuestion: (cb) => subscribe(IPC.evtSideQuestion, cb),
  onPermission: (cb) => subscribe(IPC.evtPermission, cb),
  onPermissionCancel: (cb) => subscribe(IPC.evtPermissionCancel, cb),
  onScriptOutput: (cb) => subscribe(IPC.evtScriptOutput, cb),
  onScriptExit: (cb) => subscribe(IPC.evtScriptExit, cb),
  onComposerAttach: (cb) => subscribe(IPC.evtComposerAttach, cb),
  onState: (cb) => subscribe(IPC.evtState, cb),
  onStackProgress: (cb) => subscribe(IPC.evtStackProgress, cb),
  onReview: (cb) => subscribe(IPC.evtReview, cb),
  onSelectWorkspace: (cb) => subscribe(IPC.evtSelectWorkspace, cb),
  onOpenRepoSettings: (cb) => subscribe(IPC.evtOpenRepoSettings, cb),
  onWindowFocus: (cb) => subscribe(IPC.evtWindowFocus, () => cb()),
  onWindowBlur: (cb) => subscribe(IPC.evtWindowBlur, () => cb()),
  onClaudeLogin: (cb) => subscribe(IPC.evtClaudeLogin, cb),
  onCodexLogin: (cb) => subscribe(IPC.evtCodexLogin, cb),
  onGithubLogin: (cb) => subscribe(IPC.evtGithubLogin, cb),
  onAuthChanged: (cb) => subscribe(IPC.evtAuthChanged, cb),
  onUpdate: (cb) => subscribe(IPC.evtUpdate, cb),
  onNotice: (cb) => subscribe(IPC.evtNotice, cb)
}

contextBridge.exposeInMainWorld('api', api)
