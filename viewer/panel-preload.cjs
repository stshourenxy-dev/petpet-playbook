// PetPet 日记面板 - preload 桥接（最小暴露面：只收数据）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('panelAPI', {
  onDiaryData: (cb) => ipcRenderer.on('diary:data', (_e, data) => cb(data)),
  onDiaryStatus: (cb) => ipcRenderer.on('diary:status', (_e, info) => cb(info)),
  close: () => ipcRenderer.send('diary:close')
})
