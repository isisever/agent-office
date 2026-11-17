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
    setGroup: (id, group) => ipcRenderer.invoke('projects:setGroup', id, group),   // v3.86 the PROJECTS list's group ('' = none)
    setActive: (id) => ipcRenderer.invoke('projects:setActive', id),
    setAccount: (id, accountId) => ipcRenderer.invoke('projects:setAccount', id, accountId),
    setManager: (id, value) => ipcRenderer.invoke('projects:setManager', id, value),   // true | false | null (global setting); { restarted: pty ids } (v3.10)
    setBossModel: (id, value) => ipcRenderer.invoke('projects:setBossModel', id, value), // 'sonnet' | 'opus' | 'haiku' | null (Auto); { restarted: pty ids } (v3.27)
    effectiveModel: (id) => ipcRenderer.invoke('projects:effectiveModel', id), // what Auto runs on: { model, family, source, manager } | null (v3.53)
    setAgentModel: (id, value) => ipcRenderer.invoke('projects:setAgentModel', id, value), // 'sonnet' | 'haiku' | 'opus' | null (Auto); { restarted: pty ids } (v3.14)
    setContextCap: (id, value) => ipcRenderer.invoke('projects:setContextCap', id, value), // 200000 | 400000 | null (Auto); { restarted: pty ids } (v3.15)
    setSkillPacks: (id, values) => ipcRenderer.invoke('projects:setSkillPacks', id, values), // { [packId]: 'inherit' | 'on' | 'off' } in one call; { restarted } (v3.45)
    setSavings: (id, value) => ipcRenderer.invoke('projects:setSavings', id, value), // 'off' | 'normal' | 'strict'; { restarted: pty ids } (v3.20)
    setBackup: (id, value) => ipcRenderer.invoke('projects:setBackup', id, value), // null (none) | 'auto' | account id (v3.17)
    setDelegates: (id, ids) => ipcRenderer.invoke('projects:setDelegates', id, ids), // string[] of other account ids the boss may delegate to (v3.56)
    setEngine: (id, value) => ipcRenderer.invoke('projects:setEngine', id, value), // 'agy' | 'commandcode' | null (Claude Code); { restarted: pty ids }, every tab fresh, or { restarted: [], refused } when a tab is working (v3.22, v3.25)
    setProjectFiles: (id, value) => ipcRenderer.invoke('projects:setProjectFiles', id, value), // true | false; { restarted, written, removed, refused } (v3.38)
    setAutoApprove: (id, value) => ipcRenderer.invoke('projects:setAutoApprove', id, value), // true | false; { restarted: pty ids } (v3.71)
    setSkipPermissions: (id, value) => ipcRenderer.invoke('projects:setSkipPermissions', id, value), // true | false; { restarted: pty ids } (v3.72)
    openFolder: (id) => ipcRenderer.invoke('projects:openFolder', id),   // opens the project's folder in the file manager → boolean
    menu: (id) => ipcRenderer.invoke('projects:menu', id),   // right click: native menu (move the session to another computer, v3.4)
    onChange: listen('projects:changed'),
  },
  skillPacks: {   // contract v3.45: bundled skill packs (Claude Code only)
    list: (projectId) => ipcRenderer.invoke('skillPacks:list', projectId),   // { packs: [{ id, name, license, skills, defaultOn, paidApi, managerOff, repo, sha, on, project, active, owned, ownedSkills }] }
    set: (id, on) => ipcRenderer.invoke('skillPacks:set', id, on),   // global on/off → { restarted }
  },
  mcp: {   // contract v3.44: one MCP list; the token goes in, never out
    list: (projectId) => ipcRenderer.invoke('mcp:list', projectId),   // { servers: [{ name, source, type, host, readOnly, id?, scope?, hasToken?, approved?, shadowed? }] }
    add: (form) => ipcRenderer.invoke('mcp:add', form),   // remote { name, url, type: 'http' | 'sse', token?, scope } | stdio { name, type: 'stdio', command, args: string[], env: {k: v}, scope }; scope: 'all' | projectId | projectId[] (v3.82) → { ok, restarted } | { ok: false, error }
    get: (id) => ipcRenderer.invoke('mcp:get', id),   // v3.69 → { ok, server: remote { id, name, type, url, urlHidden?, scope, hasToken } | stdio { id, name, type, command, args, env, scope } } (never the token)
    update: (id, form) => ipcRenderer.invoke('mcp:update', id, form),   // v3.69 the add form plus clearToken?; blank token/url keep the stored ones → { ok, restarted } | { ok: false, error }
    getFile: (projectId, where, name) => ipcRenderer.invoke('mcp:getFile', projectId, where, name),   // v3.69 a server in Claude Code's files → { ok, server: { name, type, url, urlHidden?, headers: {k: MASK} | command, args, env: {k: MASK}, where } } (values masked)
    updateFile: (projectId, where, name, form) => ipcRenderer.invoke('mcp:updateFile', projectId, where, name, form),   // v3.69 edits that entry in that file; a MASK value or blank url keeps the stored one → { ok, name } | { ok: false, error }
    remove: (id) => ipcRenderer.invoke('mcp:remove', id),   // → { ok, restarted } | { ok: false, error: 'unknown' }
    apps: () => ipcRenderer.invoke('mcp:apps'),   // v3.82 → { servers: [{ id, name, type, host, scope: 'all' | projectId | projectId[], hasToken }] }
    scope: (id, scope) => ipcRenderer.invoke('mcp:scope', id, scope),   // v3.82 scope: 'all' | projectId[] → { ok, restarted } | { ok: false, error: 'unknown' | 'scope' | 'name-used' }
  },
  // v3.83 team: staff kept in Agent Office (never in a project folder); team mode is prefs.teamMode
  staff: {
    list: () => ipcRenderer.invoke('staff:list'),           // → { teamMode, presets: RoleDef[], staff: Staff[] }
    save: (form) => ipcRenderer.invoke('staff:save', form), // add (no id) or edit → { ok, member } | { ok: false, error: 'name' | 'role' | 'name-used' | 'too-many' | 'state' }
    remove: (id) => ipcRenderer.invoke('staff:remove', id), // → { ok } | { ok: false, error: 'unknown' }
    desk: (projectId, staffId) => ipcRenderer.invoke('staff:desk', projectId, staffId),   // v3.83 opens (and starts) the member's desk → { ok, id } | { ok: false, error }
    personal: (staffId) => ipcRenderer.invoke('staff:personal', staffId),   // v3.83 amendment: opens the member's personal workspace desk (made on first use)
    desks: () => ipcRenderer.invoke('staff:desks'),         // → [{ id, projectId, n, staffId, state: 'busy' | 'idle' | 'asleep' | 'off' }]
    onDesks: listen('staff:desks'),                         // the same list when it changes
    setParallel: (projectId, on) => ipcRenderer.invoke('projects:setParallel', projectId, on),   // several desks at once, each in its own worktree
  },
  // v3.85 mail: accounts (passwords and tokens go in, never out) and the outbox; sending is only mail.send, the person's click
  mail: {
    accounts: () => ipcRenderer.invoke('mail:accounts'),            // → { accounts: [{ id, label, provider, address, imap?, smtp?, user?, clientId?, tenant?, hasSecret }], encryption }
    save: (form) => ipcRenderer.invoke('mail:save', form),          // Gmail / IMAP add or edit (password: blank keeps it) → { ok, account } | { ok: false, error }
    remove: (id) => ipcRenderer.invoke('mail:remove', id),          // the account, its secret, and every member's access to it
    test: (id) => ipcRenderer.invoke('mail:test', id),              // log in and list one → { ok } | { ok: false, error }
    m365Start: (form) => ipcRenderer.invoke('mail:m365Start', form), // { clientId, tenant?, label? } → { ok, userCode, verificationUri } | { ok: false, error }
    m365Cancel: () => ipcRenderer.invoke('mail:m365Cancel'),
    onM365: listen('mail:m365'),                                     // the sign-in's end: { ok, address } | { ok: false, error }
    onAccounts: listen('mail:accounts'),
    outbox: () => ipcRenderer.invoke('mail:outbox'),                 // → { drafts, pending, plans, pendingPlans }
    onOutbox: listen('mail:outbox'),
    edit: (id, form) => ipcRenderer.invoke('mail:edit', id, form),   // the person's changes to a pending draft
    send: (id) => ipcRenderer.invoke('mail:send', id),               // the one way a mail leaves → { ok } | { ok: false, error }
    discard: (id) => ipcRenderer.invoke('mail:discard', id),
    retry: (id) => ipcRenderer.invoke('mail:retry', id),
    planRun: (id, keep) => ipcRenderer.invoke('mail:planRun', id, keep),  // v3.93 the person's Approve: { creates?, renames?, moves?, removes? } kept indexes
    planDiscard: (id) => ipcRenderer.invoke('mail:planDiscard', id),
  },
  // v3.84 the person's own roles (listed with the presets in staff.list) and the role wizard
  roles: {
    save: (form) => ipcRenderer.invoke('roles:save', form),   // { id?, name, short?, department?, description, brief, writesCode, skillPacks, tools } → { ok, role } | { ok: false, error: 'name' | 'brief' | 'name-used' | 'too-many' | 'state' }
    remove: (id) => ipcRenderer.invoke('roles:remove', id),   // members using it keep it as their own role → { ok } | { ok: false, error: 'unknown' | 'state' }
    wizard: (req) => ipcRenderer.invoke('roles:wizard', req), // { messages: [{ who: 'user' | 'wizard', text }], lang } → { ok, say, questions, role? } | { ok: false, error: 'busy' | 'empty' | 'no-claude' | 'timeout' | 'failed' }
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
  // login(mode): 'console' (normal: device code, the default), 'auth' (one provider, OAuth or API key) or 'logout'.
  // Not logged in is normal: free models need none.
  oc: {
    auth: (refresh) => ipcRenderer.invoke('oc:auth', refresh),   // { installed, state: 'in' | 'out' | 'missing', major: number | null, providers?: [{ id, type }] }
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
    shown: (id) => ipcRenderer.send('pty:shown', id),   // v3.47 the tab on screen changed ('' = none)
    onReloaded: listen('pty:reloaded'),                 // v3.11: restarted in its session because its MCP servers changed
    onSleep: listen('pty:sleep'),                       // an idle background claude was ended to save memory
  },
  // v3.80 chat view: a Claude Code tab's conversation read from its transcript; a message is typed into the tab
  chat: {
    read: (id, cursor) => ipcRenderer.invoke('chat:read', id, cursor),   // → { unsupported } | { sid, cursor, items, reset, more }
    send: (id, text) => ipcRenderer.invoke('chat:send', id, text),       // → 'ok' | why not ('empty', 'not-running', 'permission', 'draft', 'locked', …)
    keys: (id, steps, expect) => ipcRenderer.invoke('chat:keys', id, steps, expect),     // expect: the key of the menu the card shows; a menu answer: ['2'] | ['3', { text }, '\r'] | ['\x1b'] …; → 'ok' | why not
    commands: (id) => ipcRenderer.invoke('chat:commands', id),           // the "/" list → [{ name, description, source, ui? }]
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
    get: () => ipcRenderer.invoke('prefs:get'),         // { resume: boolean, resumeWork: boolean, theme: 'auto' | name, look: 'pixel' | 'claude', mode: 'system' | 'light' | 'dark', manager: boolean, shareMcp: boolean, reloadMcp: boolean, fallback: boolean, sleepMinutes: 0 | 15 | 30 | 60, keepAwake: 'off' | 'working' | 'always', showAgyAccount: boolean | null, showCmdAccount: boolean | null, showOcAccount: boolean | null, office3d: boolean, teamMode: boolean } (theme: v3.1, manager: v3.2, sleepMinutes: v3.3, resumeWork: v3.7, shareMcp: v3.9, reloadMcp: v3.11, fallback: v3.17, showAgyAccount/showCmdAccount: v3.30, showOcAccount: v3.40, look/mode: v3.74, chatView: v3.80, office3d: v3.81, teamMode: v3.83, keepAwake: v3.78)
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
  // v3.46 HQ: board, settings, report text (data), remote rows' manage actions
  hq: {
    get: () => ipcRenderer.invoke('hq:get'),
    setSettings: (patch) => ipcRenderer.invoke('hq:setSettings', patch),
    open: () => ipcRenderer.invoke('hq:open'),
    markRead: (id) => ipcRenderer.invoke('hq:markRead', id),
    openFolder: () => ipcRenderer.invoke('hq:openFolder'),
    report: (id) => ipcRenderer.invoke('hq:report', id),
    remoteOp: (key, op) => ipcRenderer.invoke('hq:remoteOp', key, op),
    cancel: (id) => ipcRenderer.invoke('hq:cancel', id),
    resume: (id) => ipcRenderer.invoke('hq:resume', id),   // v3.92 Continue on a blocked stage
    onBoard: listen('hq:board'),
  },
  // v3.47 Routines: definitions only from this UI (no MCP tool, no peer); held approvals answered here
  routines: {
    get: () => ipcRenderer.invoke('routines:get'),
    save: (r) => ipcRenderer.invoke('routines:save', r),
    remove: (id) => ipcRenderer.invoke('routines:delete', id),
    setPaused: (id, paused) => ipcRenderer.invoke('routines:setPaused', id, paused),
    runNow: (id) => ipcRenderer.invoke('routines:runNow', id),
    approve: (heldId, allow) => ipcRenderer.invoke('routines:approve', heldId, allow),
    markRead: (runId) => ipcRenderer.invoke('routines:markRead', runId),
    setCfg: (cfg) => ipcRenderer.invoke('routines:setCfg', cfg),
    preview: (schedule) => ipcRenderer.invoke('routines:preview', schedule),
    summary: (request) => ipcRenderer.invoke('routines:summary', request),
    onChange: listen('routines:changed'),
  },
  office: {
    onData: listen('office:data'),
    themes: () => ipcRenderer.invoke('office:themes'),   // gallery + user themes.json (contract v3.1)
    today: () => ipcRenderer.invoke('office:today'),     // today's deliveries (contract v2.9)
  },
});
