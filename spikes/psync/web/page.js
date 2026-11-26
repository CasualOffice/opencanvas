// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// PSYNC-01 spike page: paints a first screen the way each approach would, then reports timings.
// Not the editor: a minimal DOM render of the first blocks, the same for every mode, so the
// difference between modes is what is fetched and decoded before it.
import * as Y from 'yjs'

const FIRST = 8
const ROWS = 30
const mode = new URLSearchParams(location.search).get('mode')
const root = document.getElementById('root')
const keep = (window.__keep = [])

async function bin(u) {
  return new Uint8Array(await (await fetch(u)).arrayBuffer())
}

function textOfY(node) {
  if (node instanceof Y.XmlText) return node.toDelta().map((d) => d.insert).join('')
  return node.toArray().map(textOfY).join('')
}

function textOfJson(n) {
  if (n.text) return n.text
  return (n.content || []).map(textOfJson).join('')
}

function para(tag, text) {
  const el = document.createElement(tag)
  el.textContent = text
  el.contentEditable = 'true'
  root.appendChild(el)
}

function table(fields, rows) {
  const t = document.createElement('table')
  const h = t.insertRow()
  for (const f of fields) h.insertCell().textContent = f.name
  for (const r of rows) {
    const tr = t.insertRow()
    for (const f of fields) tr.insertCell().textContent = String(r[f.id] ?? '')
  }
  root.appendChild(t)
}

function placeholder(height) {
  const d = document.createElement('div')
  d.style.height = `${height}px`
  d.className = 'ph'
  root.appendChild(d)
}

function dbFromY(dbMap) {
  const order = dbMap.get('order').toArray().slice(0, ROWS)
  const rows = dbMap.get('rows')
  return [dbMap.get('fields').toJSON(), order.map((id) => rows.get(id).toJSON())]
}

/** Renders the first blocks of a Y document; heavy blocks from `subs` (or a placeholder). */
function renderY(doc, subs, dbFirst) {
  const nodes = doc.getXmlFragment('content').toArray()
  let blocks = nodes.slice(0, FIRST)
  if (dbFirst) {
    const db = nodes.find((n) => n.nodeName === 'database' && n.getAttribute('dbId') === 'db00')
    blocks = [...nodes.slice(0, 2), db, ...nodes.slice(2, FIRST - 1)]
  }
  for (const n of blocks) {
    if (n.nodeName === 'database') {
      const id = n.getAttribute('dbId')
      const m = (subs[id] || doc).getMap('databases').get(id)
      if (m.get('split')) placeholder(m.get('height'))
      else table(...dbFromY(m))
    } else para(n.nodeName === 'heading' ? 'h2' : 'p', textOfY(n))
  }
}

function renderJson(proj) {
  for (const b of proj.blocks) {
    if (b.projection) {
      const p = b.projection
      table(p.fields, Object.values(p.rows))
    } else if (b.type === 'database' || b.type === 'board') placeholder(480)
    else para(b.type === 'heading' ? 'h2' : 'p', textOfJson(b))
  }
}

const painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))

async function run() {
  const dbFirst = mode.endsWith('-db')
  let editable
  if (mode.startsWith('full')) {
    const doc = new Y.Doc(); keep.push(doc)
    Y.applyUpdate(doc, await bin('/d/full.bin'))
    renderY(doc, {}, dbFirst)
  } else if (mode.startsWith('sub')) {
    const doc = new Y.Doc(); keep.push(doc)
    const subs = {}
    const [main, db] = await Promise.all([
      bin('/d/main.bin'),
      dbFirst ? bin('/d/sub/db00.bin') : null,
    ])
    Y.applyUpdate(doc, main)
    if (db) {
      subs.db00 = new Y.Doc(); keep.push(subs.db00)
      Y.applyUpdate(subs.db00, db)
    }
    renderY(doc, subs, dbFirst)
  } else {
    const proj = await (await fetch(dbFirst ? '/d/proj-db.json' : '/d/proj.json')).json()
    renderJson(proj)
    // The full sync follows; the caret is only placeable once it has arrived.
    editable = (async () => {
      await painted()
      const doc = new Y.Doc(); keep.push(doc)
      Y.applyUpdate(doc, await bin('/d/full.bin'))
      return performance.now()
    })()
  }
  await painted()
  const first = performance.now()
  const bytes = performance
    .getEntriesByType('navigation')
    .concat(performance.getEntriesByType('resource').filter((e) => e.responseEnd <= first))
    .reduce((s, e) => s + e.transferSize, 0)
  const caret = editable ? await editable : first
  window.__result = { mode, first, caret, bytes }
}

run().catch((e) => {
  window.__result = { mode, error: String(e) }
})
