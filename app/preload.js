// A narrow bridge to the renderer: window.agentOffice (see CONTRACT.md).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Passes all of the channel's arguments to the callback; the returned function unsubscribes.
const listen = (ch) => (cb) => {
  const h = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('agentOffice', {
  platform: process.platform,                           // 'darwin' | 'linux' | 'win32': the title bar and shortcuts follow it
  // home folder (from main, v3.18): the title bar writes it as ~; a sandboxed preload has no os module
  home: (process.argv.find((a) => a.startsWith('--agent-office-home=')) || '').slice('--agent-office-home='.length) || null,
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    add: () => ipcRenderer.invoke('projects:add'),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
    setActive: (id) => ipcRenderer.invoke('projects:setActive', id),
    setAccount: (id, accountId) => ipcRenderer.invoke('projects:setAccount', id, accountId),
    setManager: (id, value) => ipcRenderer.invoke('projects:setManager', id, value),   // true | false | null (global setting); { restarted: pty ids } (v3.10)
    setBossModel: (id, value) => ipcRenderer.invoke('projects:setBossModel', id, value), // 'sonnet' | 'opus' | 'haiku' | null (Auto); { restarted: pty ids } (v3.27)
    setAgentModel: (id, value) => ipcRenderer.invoke('projects:setAgentModel', id, value), // 'sonnet' | 'haiku' | 'opus' | null (Auto); { restarted: pty ids } (v3.14)
    setContextCap: (id, value) => ipcRenderer.invoke('projects:setContextCap', id, value), // 200000 | 400000 | null (Auto); { restarted: pty ids } (v3.15)
    setSavings: (id, value) => ipcRenderer.invoke('projects:setSavings', id, value), // 'off' | 'normal' | 'strict'; { restarted: pty ids } (v3.20)
    setBackup: (id, value) => ipcRenderer.invoke('projects:setBackup', id, value), // null (none) | 'auto' | account id (v3.17)
    setEngine: (id, value) => ipcRenderer.invoke('projects:setEngine', id, value), // 'agy' | 'commandcode' | null (Claude Code); { restarted: pty ids }, every tab fresh, or { restarted: [], refused } when a tab is working (v3.22, v3.25)
    setProjectFiles: (id, value) => ipcRenderer.invoke('projects:setProjectFiles', id, value), // true | false; { restarted, written, removed, refused } (v3.38)
    menu: (id) => ipcRenderer.invoke('projects:menu', id),   // right click: native menu (move the session to another computer, v3.4)
    onChange: listen('projects:changed'),
  },
  tabs: {
    add: (projectId, mode) => ipcRenderer.invoke('tabs:add', projectId, mode),   // mode: 'same' | 'worktree' | undefined (menu)
    close: (projectId, n) => ipcRenderer.invoke('tabs:close', projectId, n),    // { closed, restarted? }
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: (label) => ipcRenderer.invoke('accounts:add', label),
    rename: (id, label) => ipcRenderer.invoke('accounts:rename', id, label),
    setShare: (id, on) => ipcRenderer.invoke('accounts:setShare', id, on),   // use Default's plugins, skills, MCP servers (v3.6)
    remove: (id) => ipcRenderer.invoke('accounts:remove', id),
    onChange: listen('accounts:changed'),
    onFallback: listen('account:fallback'),             // v3.17: { projectId, kind: 'switched' | 'returned' | 'stuck', text, from?, to?, ptyIds?, reason? }
    refreshAuth: (id) => ipcRenderer.invoke('accounts:refreshAuth', id),
    login: (id) => ipcRenderer.invoke('accounts:login', id),
    logout: (id) => ipcRenderer.invoke('accounts:logout', id),
  },
  // v3.24: Antigravity's single login in the Accounts section (AgyAuth of src/agy-auth.js); the pty is 'login:agy'
  agy: {
    auth: (refresh) => ipcRenderer.invoke('agy:auth', refresh),
    login: () => ipcRenderer.invoke('agy:login'),
    onAuth: listen('agy:auth'),
  },
  // v3.30: Command Code's single login in the Accounts section (CmdAuth of src/cmd-auth.js); the pty is 'login:cmd'
  cmd: {
    auth: (refresh) => ipcRenderer.invoke('cmd:auth', refresh),
    login: () => ipcRenderer.invoke('cmd:login'),
    onAuth: listen('cmd:auth'),
  },
  // v3.40: OpenCode's logins in the Accounts section (OcAuth of src/oc-auth.js); the pty is 'login:oc'.
  // login(mode): 'login' (auth login, the default) or 'logout' (auth logout). Not logged in is normal: free models need none.
  oc: {
    auth: (refresh) => ipcRenderer.invoke('oc:auth', refresh),   // { installed, state: 'in' | 'out' | 'missing', providers?: [{ id, type }] }
    login: (mode) => ipcRenderer.invoke('oc:login', mode),
    onAuth: listen('oc:auth'),
  },
  pty: {
    write: (id, d) => ipcRenderer.send('pty:write', id, d),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    onData: listen('pty:data'),
    onExit: listen('pty:exit'),
    restart: (id) => ipcRenderer.send('pty:restart', id),
    wake: (id) => ipcRenderer.send('pty:wake', id),     // the tab is shown: a sleeping claude starts
    onReloaded: listen('pty:reloaded'),                 // v3.11: restarted in its session because its MCP servers changed
    onSleep: listen('pty:sleep'),                       // an idle background claude was ended to save memory
  },
  work: {
    resumeUnfinished: () => ipcRenderer.invoke('work:resumeUnfinished'), // v3.8: { resumed: [{ id, name }], skipped: [{ id, name }] }
    onResumed: listen('work:resumed'),                  // the same result after the menu item
  },
  clipboard: {
    hasImage: () => ipcRenderer.invoke('clipboard:hasImage'),
    read: () => ipcRenderer.invoke('clipboard:read'),   // { hasImage, text, files }
    onPaste: listen('edit:paste'),                      // the menu's Paste (⌘V; Ctrl+Shift+V on Linux and Windows)
    nativePaste: () => ipcRenderer.send('edit:nativePaste'), // outside the terminal: normal paste
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  update: {
    state: () => ipcRenderer.invoke('update:state'),   // { version, ready }
    onReady: listen('update:ready'),                    // downloaded version number
    install: () => ipcRenderer.send('update:install'),
  },
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get'),         // { resume: boolean, resumeWork: boolean, theme: 'auto' | name, manager: boolean, shareMcp: boolean, reloadMcp: boolean, fallback: boolean, sleepMinutes: 0 | 15 | 30 | 60, showAgyAccount: boolean | null, showCmdAccount: boolean | null, showOcAccount: boolean | null } (theme: v3.1, manager: v3.2, sleepMinutes: v3.3, resumeWork: v3.7, shareMcp: v3.9, reloadMcp: v3.11, fallback: v3.17, showAgyAccount/showCmdAccount: v3.30, showOcAccount: v3.40)
    set: (p) => ipcRenderer.invoke('prefs:set', p),
  },
  language: {
    get: () => ipcRenderer.invoke('language:get'),                 // { setting: 'auto'|code, lang: code, languages: [{ code, name }] } (locales/*.json)
    set: (setting) => ipcRenderer.invoke('language:set', setting),
    onChange: listen('language:changed'),                           // { setting, lang, languages }
  },
  tokens: {                                             // v3.13: token usage per project, from the transcripts
    report: (projectId) => ipcRenderer.invoke('tokens:report', projectId), // TokenReport | null
    brief: () => ipcRenderer.invoke('tokens:brief'),    // [{ id, usd, total, pct }] for today
    onBrief: listen('tokens:brief'),                    // the same, about once a minute
  },
  // v3.28: this user's other Agent Offices (src/link-host.js); every call returns the LinkView
  link: {
    get: () => ipcRenderer.invoke('link:get'),
    invite: () => ipcRenderer.invoke('link:invite'),
    join: (code) => ipcRenderer.invoke('link:join', code),          // { ok, error?, view }
    cancel: () => ipcRenderer.invoke('link:cancel'),
    setName: (name) => ipcRenderer.invoke('link:setName', name),
    rename: (id, name) => ipcRenderer.invoke('link:rename', id, name),
    setAllow: (id, on) => ipcRenderer.invoke('link:setAllow', id, on),
    remove: (id) => ipcRenderer.invoke('link:remove', id),
    setAllowHandoff: (id, on) => ipcRenderer.invoke('link:setAllowHandoff', id, on),   // v3.29
    setAllowManage: (id, on) => ipcRenderer.invoke('link:setAllowManage', id, on),     // v3.31: catalog, later project actions
    setAllowAccounts: (id, on) => ipcRenderer.invoke('link:setAllowAccounts', id, on), // v3.31: later account sign-in
    handoffAnswer: (id, accept) => ipcRenderer.invoke('link:handoffAnswer', id, accept),
    handoffAsk: (dir) => ipcRenderer.invoke('link:handoffAsk', dir),     // outcome unknown: ask the receiver again
    handoffKeep: (dir) => ipcRenderer.invoke('link:handoffKeep', dir),   // outcome unknown: keep it here (confirm dialog)
    send: (id, project, text) => ipcRenderer.invoke('link:send', id, project, text),
    handOff: (projectId, deviceId) => ipcRenderer.invoke('link:handOff', projectId, deviceId),   // v3.32 Machines panel Move ▸
    projOp: (deviceId, projectId, op) => ipcRenderer.invoke('link:projOp', deviceId, projectId, op),   // v3.33 start/wake/sleep/stop there
    // v3.34 remote Claude login relay: no URL or code ever comes back here (the page opens from main)
    loginStart: (id, account) => ipcRenderer.invoke('link:loginStart', id, account),   // { ok, id?, reason? }
    loginOpen: (loginId) => ipcRenderer.invoke('link:loginOpen', loginId),
    loginCode: (loginId, code) => ipcRenderer.invoke('link:loginCode', loginId, code), // { ok, reason? }
    loginCancel: (loginId) => ipcRenderer.invoke('link:loginCancel', loginId),
    onChange: listen('link:changed'),
  },
  office: {
    onData: listen('office:data'),
    themes: () => ipcRenderer.invoke('office:themes'),   // gallery + user themes.json (contract v3.1)
    today: () => ipcRenderer.invoke('office:today'),     // today's deliveries (contract v2.9)
  },
});
