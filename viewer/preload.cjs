// PetPet 桌宠查看器 - preload 桥接
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  listPets: () => ipcRenderer.invoke('pet:list'),
  loadPet: (petId) => ipcRenderer.invoke('pet:load', petId),
  getFile: (petId, relPath) => ipcRenderer.invoke('pet:file', petId, relPath),
  setWindowSize: (w, h) => ipcRenderer.send('view:setSize', w, h),
  moveWindow: (x, y) => ipcRenderer.send('view:move', x, y),
  setIgnoreMouse: (ignore, forward) => ipcRenderer.send('pet:setIgnoreMouse', ignore, forward),
  getWindowPosition: () => ipcRenderer.invoke('view:getPos'),
  notifyPetLoaded: (petId) => ipcRenderer.send('pet:loaded', petId),
  onPetSwitch: (cb) => ipcRenderer.on('pet:switch', (_e, id) => cb(id)),
  onAction: (cb) => ipcRenderer.on('pet:action', (_e, name) => cb(name)),
  onZoom: (cb) => ipcRenderer.on('view:zoom', (_e, factor) => cb(factor)),
  onReset: (cb) => ipcRenderer.on('view:reset', () => cb()),
  onTestAction: (cb) => ipcRenderer.on('test:action', (_e, name) => cb(name)),
  setReminder: (spec) => ipcRenderer.invoke('reminder:set', spec),
  onReminderFire: (cb) => ipcRenderer.on('reminder:fire', (_e, r) => cb(r)),
  appendActivity: (entry) => ipcRenderer.send('pet:activity', entry),
  listActivity: (petId) => ipcRenderer.invoke('pet:activity:list', petId),
  showContextMenu: (x, y) => ipcRenderer.invoke('menu:showContext', x, y),
  notifyAction: (info) => ipcRenderer.send('pet:action:notify', info),
  openDiary: (petId) => ipcRenderer.send('diary:open', petId),
  onOpenReminder: (cb) => ipcRenderer.on('open:reminder', () => cb()),
})
