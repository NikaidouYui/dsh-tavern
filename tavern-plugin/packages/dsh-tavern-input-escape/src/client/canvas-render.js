const IE_IMAGE_LIMITS = {
  width: 1024,
  height: 1024,
  margin: 54,
  top: 42,
  font: '21px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
  headerFont: '600 22px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
  lineHeight: 25,
  maxRunes: 1500,
  maxLines: 36,
  maxPages: 40,
  maxSingleBase64Chars: 210 * 1024,
}

function ieWrapLines(context, text, maxWidth) {
  const lines = []
  for (const paragraph of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (paragraph === '') {
      lines.push('')
      continue
    }
    let line = ''
    for (const ch of paragraph) {
      const next = line + ch
      if (line && context.measureText(next).width > maxWidth) {
        lines.push(line)
        line = ch
      } else {
        line = next
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

function iePaginate(context, text) {
  const lines = ieWrapLines(context, text, IE_IMAGE_LIMITS.width - IE_IMAGE_LIMITS.margin * 2)
  const pages = []
  let page = []
  let runes = 0
  const flush = () => {
    if (!page.length) return
    pages.push(page)
    page = []
    runes = 0
  }
  for (const line of lines) {
    const n = Array.from(line).length
    if (page.length && (page.length >= IE_IMAGE_LIMITS.maxLines || runes + n > IE_IMAGE_LIMITS.maxRunes)) {
      flush()
    }
    page.push(line)
    runes += n
  }
  flush()
  return pages.length ? pages : [['']]
}

function ieExportCanvasPage(canvas) {
  let mediaType = 'image/png'
  let dataUrl = canvas.toDataURL(mediaType)
  let comma = dataUrl.indexOf(',')
  let base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  if (base64.length > IE_IMAGE_LIMITS.maxSingleBase64Chars) {
    mediaType = 'image/webp'
    dataUrl = canvas.toDataURL(mediaType, 0.85)
    comma = dataUrl.indexOf(',')
    base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  }
  return { mediaType, base64 }
}

function ieRenderPage(lines, pageIndex, totalPages) {
  const canvas = document.createElement('canvas')
  canvas.width = IE_IMAGE_LIMITS.width
  canvas.height = IE_IMAGE_LIMITS.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D 不可用')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.textBaseline = 'top'
  context.fillStyle = '#18181b'
  context.font = IE_IMAGE_LIMITS.headerFont
  context.fillText(`[Role: USER] [Part ${pageIndex + 1}/${totalPages}]`, IE_IMAGE_LIMITS.margin, IE_IMAGE_LIMITS.top)
  context.strokeStyle = '#d1d5db'
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(IE_IMAGE_LIMITS.margin, IE_IMAGE_LIMITS.top + 36)
  context.lineTo(IE_IMAGE_LIMITS.width - IE_IMAGE_LIMITS.margin, IE_IMAGE_LIMITS.top + 36)
  context.stroke()
  context.fillStyle = '#18181b'
  context.font = IE_IMAGE_LIMITS.font
  let y = IE_IMAGE_LIMITS.top + 58
  for (const line of lines) {
    context.fillText(line, IE_IMAGE_LIMITS.margin, y)
    y += IE_IMAGE_LIMITS.lineHeight
  }
  const encoded = ieExportCanvasPage(canvas)
  return {
    pageIndex,
    totalPages,
    mediaType: encoded.mediaType,
    base64: encoded.base64,
  }
}

function ieRenderTextToImagePages(text) {
  if (typeof document === 'undefined') return []
  const probe = document.createElement('canvas')
  const probeCtx = probe.getContext('2d')
  if (!probeCtx) throw new Error('Canvas 2D 不可用')
  probeCtx.font = IE_IMAGE_LIMITS.font
  const pages = iePaginate(probeCtx, text)
  if (pages.length > IE_IMAGE_LIMITS.maxPages) {
    throw new Error('输入过长，超过最大图片分页数 ' + IE_IMAGE_LIMITS.maxPages)
  }
  return pages.map((lines, index) => ieRenderPage(lines, index, pages.length))
}
