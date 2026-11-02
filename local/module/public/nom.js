// Remplace « Overleaf » par « Overleaf de YomYom » dans l'interface (textes, titres,
// infobulles), sans toucher au contenu des projets : éditeur, PDF, champs de saisie.
;(function () {
  const NAME = 'Overleaf de YomYom'
  const RE = /\bOverleaf\b(?! de YomYom)/g
  const SKIP = 'script, style, textarea, input, code, pre, .cm-editor, .pdf-viewer, .pdfjs-viewer-inner, [contenteditable="true"], .ol-agent-log'
  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt']

  function fixText(node) {
    if (!RE.test(node.nodeValue)) return
    RE.lastIndex = 0
    const parent = node.parentElement
    if (!parent || parent.closest(SKIP)) return
    node.nodeValue = node.nodeValue.replace(RE, NAME)
  }

  function fixElement(el) {
    if (el.closest(SKIP)) return
    for (const a of ATTRS) {
      const v = el.getAttribute(a)
      if (v && RE.test(v)) el.setAttribute(a, v.replace(RE, NAME))
      RE.lastIndex = 0
    }
  }

  function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) return fixText(root)
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest?.(SKIP)) return
    fixElement(root)
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n =>
        n.nodeType === Node.ELEMENT_NODE && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) fixText(n)
      else fixElement(n)
    }
  }

  function fixTitle() {
    if (RE.test(document.title)) document.title = document.title.replace(RE, NAME)
    RE.lastIndex = 0
  }

  function start() {
    walk(document.body)
    fixTitle()
    new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'characterData') fixText(r.target)
        else if (r.type === 'attributes') fixElement(r.target)
        else r.addedNodes.forEach(walk)
      }
      fixTitle()
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    })
  }

  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start)
})()
