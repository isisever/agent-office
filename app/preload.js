// Renderer'a dar bir köprü: window.agentOffice (bkz. CONTRACT.md).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Kanalın tüm argümanlarını geri çağrıya geçirir; dönen işlev aboneliği kaldırır.
const listen = (ch) => (cb) => {
  const h = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('agentOffice', {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    add: () => ipcRenderer.invoke('projects:add'),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
    setActive: (id) => ipcRenderer.invoke('projects:setActive', id),
    setAccount: (id, accountId) => ipcRenderer.invoke('projects:setAccount', id, accountId),
    onChange: listen('projects:changed'),
  },
  tabs: {
    add: (projectId, mode) => ipcRenderer.invoke('tabs:add', projectId, mode),   // mode: 'same' | 'worktree' | undefined (menü)
    close: (projectId, n) => ipcRenderer.invoke('tabs:close', projectId, n),    // { closed, restarted? }
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: (label) => ipcRenderer.invoke('accounts:add', label),
    rename: (id, label) => ipcRenderer.invoke('accounts:rename', id, label),
    remove: (id) => ipcRenderer.invoke('accounts:remove', id),
    onChange: listen('accounts:changed'),
    refreshAuth: (id) => ipcRenderer.invoke('accounts:refreshAuth', id),
    login: (id) => ipcRenderer.invoke('accounts:login', id),
    logout: (id) => ipcRenderer.invoke('accounts:logout', id),
  },
  pty: {
    write: (id, d) => ipcRenderer.send('pty:write', id, d),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    onData: listen('pty:data'),
    onExit: listen('pty:exit'),
    restart: (id) => ipcRenderer.send('pty:restart', id),
  },
  clipboard: {
    hasImage: () => ipcRenderer.invoke('clipboard:hasImage'),
    read: () => ipcRenderer.invoke('clipboard:read'),   // { hasImage, text, files }
    onPaste: listen('edit:paste'),                      // menüdeki Yapıştır (⌘V)
    nativePaste: () => ipcRenderer.send('edit:nativePaste'), // terminal dışı: normal yapıştırma
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  update: {
    state: () => ipcRenderer.invoke('update:state'),   // { version, ready }
    onReady: listen('update:ready'),                    // indirilen sürüm numarası
    install: () => ipcRenderer.send('update:install'),
  },
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get'),         // { resume: boolean }
    set: (p) => ipcRenderer.invoke('prefs:set', p),
  },
  language: {
    get: () => ipcRenderer.invoke('language:get'),                 // { setting: 'auto'|'en'|'tr', lang: 'en'|'tr' }
    set: (setting) => ipcRenderer.invoke('language:set', setting),
    onChange: listen('language:changed'),                           // { setting, lang }
  },
  office: {
    onData: listen('office:data'),
    themes: () => ipcRenderer.invoke('office:themes'),
    today: () => ipcRenderer.invoke('office:today'),     // günün teslimleri (sözleşme v2.9)
  },
});
