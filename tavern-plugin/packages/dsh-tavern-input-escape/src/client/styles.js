const IE_STYLE_ID = 'dsh-tavern-input-escape-styles'

const IE_CSS = `
.ie-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  font-size: 13px;
  line-height: 1.45;
  color: inherit;
}
.ie-card {
  border: 1px solid rgba(128, 128, 128, 0.22);
  border-radius: 10px;
  padding: 10px 12px;
  background: rgba(128, 128, 128, 0.04);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ie-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ie-title {
  font-weight: 600;
  font-size: 13.5px;
}
.ie-desc {
  font-size: 12px;
  opacity: 0.72;
}
.ie-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(16, 163, 127, 0.14);
  color: #0d8a6a;
}
.ie-badge.off {
  background: rgba(128, 128, 128, 0.16);
  color: inherit;
  opacity: 0.75;
}
.ie-badge.warn {
  background: rgba(217, 119, 6, 0.16);
  color: #d97706;
}
.ie-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.ie-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 0;
}
.ie-row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ie-row-label {
  font-size: 12.5px;
  font-weight: 500;
}
.ie-row-note {
  font-size: 11.5px;
  opacity: 0.68;
}
.ie-seg {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ie-chip {
  border: 1px solid rgba(128, 128, 128, 0.28);
  border-radius: 7px;
  padding: 5px 9px;
  font-size: 12px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.ie-chip:hover {
  border-color: rgba(16, 163, 127, 0.6);
}
.ie-chip.active {
  border-color: #10a37f;
  background: rgba(16, 163, 127, 0.14);
  font-weight: 600;
}
.ie-modes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ie-mode-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.24);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.ie-mode-btn:hover {
  border-color: rgba(16, 163, 127, 0.55);
}
.ie-mode-btn.active {
  border-color: #10a37f;
  background: rgba(16, 163, 127, 0.12);
}
.ie-mode-title {
  font-size: 12.5px;
  font-weight: 600;
}
.ie-mode-sub {
  font-size: 11.5px;
  opacity: 0.72;
}
.ie-select {
  border: 1px solid rgba(128, 128, 128, 0.3);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  background: transparent;
  color: inherit;
}
.ie-telemetry {
  font-size: 11.5px;
  opacity: 0.85;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 10px;
}
.ie-tool-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.ie-tool-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.82;
}
.ie-tool-btn:hover {
  background: rgba(128, 128, 128, 0.14);
  opacity: 1;
}
.ie-tool-dot {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10a37f;
}
.ie-tool-dot.off {
  background: rgba(128, 128, 128, 0.45);
}
.ie-popover {
  position: absolute;
  right: 0;
  bottom: 36px;
  width: 268px;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid rgba(128, 128, 128, 0.28);
  background: var(--dsh-surface, #1f2126);
  color: var(--dsh-text, #eceef2);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
@media (prefers-color-scheme: light) {
  .ie-popover {
    background: var(--dsh-surface, #ffffff);
    color: var(--dsh-text, #1f2328);
  }
}
`

function ieEnsureStyleInjected() {
  if (typeof document === 'undefined' || !document.head) return
  if (document.getElementById(IE_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = IE_STYLE_ID
  style.textContent = IE_CSS
  document.head.appendChild(style)
}
