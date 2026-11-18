const RM_STYLE_ID = 'dsh-tavern-request-monitor-styles'

const RM_CSS = `
.rm-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.48;
  color: inherit;
  box-sizing: border-box;
}
.rm-root *, .rm-overlay * {
  box-sizing: border-box;
}
.rm-card {
  border: 1px solid rgba(128, 128, 128, 0.22);
  border-radius: 10px;
  padding: 9px 11px;
  background: rgba(128, 128, 128, 0.04);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.rm-row-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.rm-title {
  font-weight: 600;
  font-size: 13.5px;
}
.rm-muted {
  opacity: 0.7;
  font-size: 11.5px;
}
.rm-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.rm-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid rgba(128, 128, 128, 0.28);
  border-radius: 7px;
  padding: 4px 9px;
  font-size: 11.5px;
  background: rgba(128, 128, 128, 0.06);
  color: inherit;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.rm-btn:hover {
  border-color: rgba(16, 163, 127, 0.65);
  background: rgba(16, 163, 127, 0.1);
}
.rm-btn.primary {
  border-color: rgba(16, 163, 127, 0.6);
  background: rgba(16, 163, 127, 0.16);
  font-weight: 600;
}
.rm-btn.active {
  border-color: #10a37f;
  background: rgba(16, 163, 127, 0.18);
  font-weight: 600;
}
.rm-btn.danger:hover {
  border-color: rgba(239, 68, 68, 0.7);
  background: rgba(239, 68, 68, 0.12);
}
.rm-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(128, 128, 128, 0.14);
  white-space: nowrap;
}
.rm-badge.ok {
  background: rgba(16, 163, 127, 0.16);
  color: #10a37f;
}
.rm-badge.warn {
  background: rgba(217, 119, 6, 0.16);
  color: #d97706;
}
.rm-badge.err {
  background: rgba(239, 68, 68, 0.16);
  color: #ef4444;
}
.rm-badge.info {
  background: rgba(59, 130, 246, 0.16);
  color: #3b82f6;
}
.rm-badge.purple {
  background: rgba(139, 92, 246, 0.16);
  color: #8b5cf6;
}
.rm-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.rm-dot.pending {
  animation: rm-pulse 1.1s infinite ease-in-out;
}
@keyframes rm-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.82); }
}
.rm-input {
  width: 100%;
  border: 1px solid rgba(128, 128, 128, 0.28);
  border-radius: 7px;
  padding: 5px 9px;
  font-size: 12px;
  background: rgba(128, 128, 128, 0.06);
  color: inherit;
  outline: none;
}
.rm-input:focus {
  border-color: #10a37f;
}
.rm-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rm-item {
  border: 1px solid rgba(128, 128, 128, 0.22);
  border-radius: 9px;
  padding: 8px 10px;
  background: rgba(128, 128, 128, 0.03);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-align: left;
  color: inherit;
  width: 100%;
  transition: border-color 0.15s, background 0.15s;
}
.rm-item:hover {
  border-color: rgba(16, 163, 127, 0.55);
  background: rgba(128, 128, 128, 0.07);
}
.rm-item.selected {
  border-color: #10a37f;
  background: rgba(16, 163, 127, 0.1);
}
.rm-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
  padding-bottom: 6px;
  flex-wrap: wrap;
}
.rm-tab {
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 12px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.78;
}
.rm-tab:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.1);
}
.rm-tab.active {
  opacity: 1;
  font-weight: 600;
  border-color: rgba(16, 163, 127, 0.45);
  background: rgba(16, 163, 127, 0.14);
}
.rm-msg {
  border: 1px solid rgba(128, 128, 128, 0.22);
  border-left-width: 4px;
  border-radius: 9px;
  padding: 8px 10px;
  background: rgba(128, 128, 128, 0.03);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rm-msg.role-system, .rm-msg.role-developer {
  border-left-color: #6366f1;
}
.rm-msg.role-user {
  border-left-color: #10a37f;
}
.rm-msg.role-assistant, .rm-msg.role-model {
  border-left-color: #f59e0b;
}
.rm-msg.role-tool {
  border-left-color: #06b6d4;
}
.rm-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  background: rgba(128, 128, 128, 0.07);
  border-radius: 7px;
  padding: 8px 10px;
  overflow-x: auto;
}
.rm-prose {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12.5px;
  line-height: 1.62;
}
.rm-mark {
  background: rgba(245, 158, 11, 0.35);
  border-radius: 3px;
  padding: 0 2px;
}
.rm-block-box {
  border: 1px dashed rgba(128, 128, 128, 0.32);
  border-radius: 8px;
  padding: 7px 9px;
  background: rgba(128, 128, 128, 0.05);
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.rm-img-wrap {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  max-width: 260px;
}
.rm-img-thumb {
  max-width: 100%;
  max-height: 220px;
  border-radius: 7px;
  border: 1px solid rgba(128, 128, 128, 0.28);
  cursor: zoom-in;
  background: #fff;
}
.rm-kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}
.rm-kv-cell {
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 8px;
  padding: 6px 9px;
  background: rgba(128, 128, 128, 0.04);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.rm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.rm-table th, .rm-table td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.16);
  vertical-align: top;
  word-break: break-all;
}
.rm-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(15, 18, 24, 0.72);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.rm-modal {
  width: min(1320px, 96vw);
  height: min(860px, 92vh);
  background: var(--bg-primary, #181a20);
  color: var(--text-primary, #eceef2);
  border: 1px solid rgba(128, 128, 128, 0.3);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
@media (prefers-color-scheme: light) {
  .rm-modal {
    background: var(--bg-primary, #ffffff);
    color: var(--text-primary, #1f2328);
  }
}
.rm-modal-head {
  padding: 10px 14px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.22);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.rm-modal-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 330px 1fr;
}
@media (max-width: 860px) {
  .rm-modal-body {
    grid-template-columns: 1fr;
    grid-template-rows: 230px 1fr;
  }
}
.rm-modal-side {
  border-right: 1px solid rgba(128, 128, 128, 0.2);
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px;
  gap: 8px;
}
.rm-modal-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.rm-modal-main {
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
}
.rm-lightbox {
  position: fixed;
  inset: 0;
  z-index: 10050;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  cursor: zoom-out;
}
.rm-lightbox img {
  max-width: 94vw;
  max-height: 92vh;
  border-radius: 8px;
  background: #fff;
}
.rm-tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 7px;
  border-radius: 7px;
  border: 1px solid rgba(128, 128, 128, 0.26);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
}
.rm-tool-btn:hover {
  border-color: rgba(16, 163, 127, 0.7);
  background: rgba(16, 163, 127, 0.12);
}
`

function rmEnsureStyleInjected() {
  if (typeof document === 'undefined') return
  let el = document.getElementById(RM_STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = RM_STYLE_ID
    el.textContent = RM_CSS
    document.head?.appendChild(el)
  } else if (el.textContent !== RM_CSS) {
    el.textContent = RM_CSS
  }
}
