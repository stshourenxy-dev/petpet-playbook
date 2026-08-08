// 红苕日记面板 - 渲染
function fmtTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const listEl = document.getElementById('list')
const countEl = document.getElementById('count')
const statusEl = document.getElementById('status')

// 当前状态行：红苕现在在做什么（随动作切换实时更新）
function renderStatus(info) {
  if (!info || !info.text) {
    statusEl.classList.add('hidden')
    return
  }
  statusEl.classList.remove('hidden')
  statusEl.innerHTML = ''
  if (info.mood) {
    const mood = document.createElement('span')
    mood.className = 'mood'
    mood.textContent = '·' + info.mood + '·'
    statusEl.appendChild(mood)
  }
  statusEl.appendChild(document.createTextNode(info.text))
}

document.getElementById('close').addEventListener('click', () => window.panelAPI.close())

window.panelAPI.onDiaryData(({ entries, theme, status, petName }) => {
  document.body.dataset.theme = theme || 'bro' // bro=弟弟 / sis=妹妹
  const name = petName || '宠物'
  document.title = name + '日记'
  document.getElementById('title').textContent = '📖 ' + name + '日记'
  renderStatus(status)
  countEl.textContent = entries.length ? `（共 ${entries.length} 条）` : ''
  listEl.innerHTML = ''
  if (!entries.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = `还没有日记，去戳戳${name}吧～`
    listEl.appendChild(empty)
    return
  }
  // 倒序：最新在上
  window.panelAPI.onDiaryStatus((info) => renderStatus(info))
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    const item = document.createElement('div')
    item.className = 'item'
    const t = document.createElement('div')
    t.className = 'time'
    t.textContent = fmtTime(e.ts)
    const b = document.createElement('div')
    if (e.mood) {
      const mood = document.createElement('span')
      mood.className = 'mood'
      mood.textContent = '·' + e.mood + '·'
      b.appendChild(mood)
    }
    b.appendChild(document.createTextNode(e.text || ''))
    item.appendChild(t)
    item.appendChild(b)
    listEl.appendChild(item)
  }
})
