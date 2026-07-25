import { contextBridge, ipcRenderer } from 'electron'
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
    remove: (repoId) => ipcRenderer.invoke(IPC.repoRemove, repoId),
    listBranches: (repoId) => ipcRenderer.invoke(IPC.repoListBranches, repoId)
  },

  workspace: {
    create: (args) => ipcRenderer.invoke(IPC.workspaceCreate, args),
    archive: (workspaceId) => ipcRenderer.invoke(IPC.workspaceArchive, workspaceId),
    unarchive: (workspaceId) => ipcRenderer.invoke(IPC.workspaceUnarchive, workspaceId),
    restack: (workspaceId) => ipcRenderer.invoke(IPC.workspaceRestack, workspaceId),
    splitStack: (workspaceId, name) =>
      ipcRenderer.invoke(IPC.workspaceSplitStack, workspaceId, name),
    switchBranch: (workspaceId, branch) =>
      ipcRenderer.invoke(IPC.workspaceSwitchBranch, workspaceId, branch),
    remove: (workspaceId, deleteBranch) =>
      ipcRenderer.invoke(IPC.workspaceRemove, workspaceId, deleteBranch),
    removeArchived: (repoId) => ipcRenderer.invoke(IPC.workspaceRemoveArchived, repoId),
    setPermissionMode: (workspaceId, mode) =>
      ipcRenderer.invoke(IPC.workspaceSetPermissionMode, workspaceId, mode),
    setModel: (workspaceId, model) => ipcRenderer.invoke(IPC.workspaceSetModel, workspaceId, model),
    setEffort: (workspaceId, effort) =>
      ipcRenderer.invoke(IPC.workspaceSetEffort, workspaceId, effort),
    setMuted: (workspaceId, muted) => ipcRenderer.invoke(IPC.workspaceSetMuted, workspaceId, muted),
    rename: (workspaceId, name) => ipcRenderer.invoke(IPC.workspaceRename, workspaceId, name),
    revealInFinder: (workspaceId) => ipcRenderer.invoke(IPC.workspaceRevealInFinder, workspaceId),
    openInEditor: (workspaceId) => ipcRenderer.invoke(IPC.workspaceOpenInEditor, workspaceId),
    openMemory: (workspaceId) => ipcRenderer.invoke(IPC.workspaceOpenMemory, workspaceId)
  },

  chat: {
    send: (workspaceId, text, images) =>
      ipcRenderer.invoke(IPC.chatSend, workspaceId, text, images),
    interrupt: (workspaceId) => ipcRenderer.invoke(IPC.chatInterrupt, workspaceId),
    getHistory: (workspaceId) => ipcRenderer.invoke(IPC.chatGetHistory, workspaceId),
    sideQuestion: (workspaceId, question) =>
      ipcRenderer.invoke(IPC.chatSideQuestion, workspaceId, question),
    clear: (workspaceId) => ipcRenderer.invoke(IPC.chatClear, workspaceId)
  },

  permission: {
    respond: (requestId, decision) => ipcRenderer.invoke(IPC.permissionRespond, requestId, decision)
  },

  script: {
    run: (workspaceId, kind) => ipcRenderer.invoke(IPC.scriptRun, workspaceId, kind),
    stop: (workspaceId, kind) => ipcRenderer.invoke(IPC.scriptStop, workspaceId, kind),
    getStatus: (workspaceId) => ipcRenderer.invoke(IPC.scriptGetStatus, workspaceId)
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
    checks: (workspaceId) => ipcRenderer.invoke(IPC.prChecks, workspaceId)
  },

  fs: {
    list: (workspaceId, relPath) => ipcRenderer.invoke(IPC.fsList, workspaceId, relPath),
    read: (workspaceId, relPath) => ipcRenderer.invoke(IPC.fsRead, workspaceId, relPath)
  },

  commands: {
    list: (workspaceId) => ipcRenderer.invoke(IPC.commandsList, workspaceId),
    run: (workspaceId, kind) => ipcRenderer.invoke(IPC.commandRun, workspaceId, kind),
    mcpAction: (workspaceId, serverName, action) =>
      ipcRenderer.invoke(IPC.mcpAction, workspaceId, serverName, action),
    rewindAction: (workspaceId, userMessageId) =>
      ipcRenderer.invoke(IPC.commandRewindAction, workspaceId, userMessageId)
  },

  terminal: {
    start: (workspaceId, cols, rows) =>
      ipcRenderer.invoke(IPC.terminalStart, workspaceId, cols, rows),
    input: (workspaceId, data) => ipcRenderer.invoke(IPC.terminalInput, workspaceId, data),
    runCommand: (workspaceId, command) =>
      ipcRenderer.invoke(IPC.terminalRunCommand, workspaceId, command),
    exec: (workspaceId, command) => ipcRenderer.invoke(IPC.terminalExec, workspaceId, command),
    killInline: (workspaceId, itemId) =>
      ipcRenderer.invoke(IPC.terminalKillInline, workspaceId, itemId),
    resize: (workspaceId, cols, rows) =>
      ipcRenderer.invoke(IPC.terminalResize, workspaceId, cols, rows),
    kill: (workspaceId) => ipcRenderer.invoke(IPC.terminalKill, workspaceId),
    onData: (cb) => subscribe(IPC.evtTerminalData, cb),
    onExit: (cb) => subscribe(IPC.evtTerminalExit, cb)
  },

  app: {
    setBadgeCount: (count) => ipcRenderer.invoke(IPC.appSetBadge, count),
    getVersion: () => ipcRenderer.invoke(IPC.appGetVersion)
  },

  update: {
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    quitAndInstall: () => ipcRenderer.invoke(IPC.updateQuitAndInstall)
  },

  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),

  settings: {
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch)
  },

  auth: {
    getStatus: () => ipcRenderer.invoke(IPC.authGetStatus),
    claudeLoginStart: () => ipcRenderer.invoke(IPC.authClaudeLoginStart),
    claudeLoginSubmitCode: (code) => ipcRenderer.invoke(IPC.authClaudeLoginSubmitCode, code),
    claudeLoginCancel: () => ipcRenderer.invoke(IPC.authClaudeLoginCancel),
    claudeLogout: () => ipcRenderer.invoke(IPC.authClaudeLogout),
    githubLoginStart: () => ipcRenderer.invoke(IPC.authGithubLoginStart),
    githubLoginCancel: () => ipcRenderer.invoke(IPC.authGithubLoginCancel),
    githubLogout: () => ipcRenderer.invoke(IPC.authGithubLogout)
  },

  onChat: (cb) => subscribe(IPC.evtChat, cb),
  onSideQuestion: (cb) => subscribe(IPC.evtSideQuestion, cb),
  onPermission: (cb) => subscribe(IPC.evtPermission, cb),
  onPermissionCancel: (cb) => subscribe(IPC.evtPermissionCancel, cb),
  onScriptOutput: (cb) => subscribe(IPC.evtScriptOutput, cb),
  onScriptExit: (cb) => subscribe(IPC.evtScriptExit, cb),
  onState: (cb) => subscribe(IPC.evtState, cb),
  onSelectWorkspace: (cb) => subscribe(IPC.evtSelectWorkspace, cb),
  onWindowFocus: (cb) => subscribe(IPC.evtWindowFocus, () => cb()),
  onWindowBlur: (cb) => subscribe(IPC.evtWindowBlur, () => cb()),
  onClaudeLogin: (cb) => subscribe(IPC.evtClaudeLogin, cb),
  onGithubLogin: (cb) => subscribe(IPC.evtGithubLogin, cb),
  onUpdate: (cb) => subscribe(IPC.evtUpdate, cb)
}

contextBridge.exposeInMainWorld('api', api)
