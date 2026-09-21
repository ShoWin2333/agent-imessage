const STYLE_ID = 'dsh-imessage-styles'
let users = 0

/** Install the client bundle's self-contained settings styles. */
export function installStyles(): () => void {
  let style = document.getElementById(STYLE_ID)
  if (style === null) {
    style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.append(style)
  }
  users += 1
  return () => {
    users = Math.max(0, users - 1)
    if (users === 0) document.getElementById(STYLE_ID)?.remove()
  }
}

const CSS = `
.dsh-imessage-section {
  box-sizing: border-box;
  display: grid;
  gap: 16px;
  width: min(100%, 760px);
  padding: 24px 24px 48px;
  color: var(--dsw-alias-label-primary, #ececf1);
}
.dsh-imessage-heading h1 {
  margin: 2px 0 6px;
  font-size: 26px;
  line-height: 1.2;
}
.dsh-imessage-heading p { margin: 0; color: var(--dsw-alias-label-secondary, #a8a8b3); }
.dsh-imessage-heading .dsh-imessage-eyebrow {
  color: var(--dsw-alias-brand-primary, #8ca9ff);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.dsh-imessage-card {
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--dsw-alias-border-l2, #383842);
  border-radius: 12px;
  background: var(--dsw-alias-bg-module-platform, rgba(255,255,255,.025));
}
.dsh-imessage-card-title,
.dsh-imessage-card-title > div,
.dsh-imessage-actions,
.dsh-imessage-line {
  display: flex;
  align-items: center;
}
.dsh-imessage-card-title { justify-content: space-between; gap: 12px; }
.dsh-imessage-card-title > div { gap: 10px; min-width: 0; }
.dsh-imessage-card-title span {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08));
  color: var(--dsw-alias-label-secondary, #b6b6c1);
  font-size: 12px;
  font-weight: 700;
}
.dsh-imessage-card-title h2 { margin: 0; font-size: 16px; }
.dsh-imessage-card-title small {
  color: var(--dsw-alias-label-tertiary, #8e8e99);
  text-align: right;
}
.dsh-imessage-body,
.dsh-imessage-muted,
.dsh-imessage-warning,
.dsh-imessage-error,
.dsh-imessage-footnote { margin: 0; line-height: 1.5; }
.dsh-imessage-body { color: var(--dsw-alias-label-secondary, #b6b6c1); }
.dsh-imessage-muted,
.dsh-imessage-footnote { color: var(--dsw-alias-label-tertiary, #8e8e99); font-size: 13px; }
.dsh-imessage-warning { color: var(--dsw-alias-state-warn-label, #f4c978); }
.dsh-imessage-error { color: var(--dsw-alias-state-error-primary, #ff7f86); font-size: 13px; }
.dsh-imessage-footnote { padding: 2px 4px; }
.dsh-imessage-device {
  display: grid;
  gap: 8px;
  padding: 14px;
  border: 1px dashed var(--dsw-alias-border-l3, #4a4a56);
  border-radius: 10px;
}
.dsh-imessage-label {
  color: var(--dsw-alias-label-tertiary, #8e8e99);
  font-size: 12px;
  font-weight: 600;
}
.dsh-imessage-code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: clamp(24px, 6vw, 38px);
  letter-spacing: .12em;
}
.dsh-imessage-actions { flex-wrap: wrap; gap: 8px; }
.dsh-imessage-button {
  box-sizing: border-box;
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  padding: 7px 12px;
  border: 1px solid var(--dsw-alias-border-l2, #454550);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #ececf1);
  font: inherit;
  font-size: 13px;
  line-height: 1.2;
  text-decoration: none;
  cursor: pointer;
}
.dsh-imessage-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.dsh-imessage-button:focus-visible,
.dsh-imessage-form input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #82a4ff); outline-offset: 2px; }
.dsh-imessage-button:disabled { opacity: .48; cursor: not-allowed; }
.dsh-imessage-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #526fd1);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dsh-imessage-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #607dde); }
.dsh-imessage-danger { color: var(--dsw-alias-state-error-primary, #ff7f86); }
.dsh-imessage-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(255,80,90,.1)); }
.dsh-imessage-form { display: grid; gap: 9px; }
.dsh-imessage-form label { font-size: 13px; font-weight: 600; }
.dsh-imessage-form input {
  box-sizing: border-box;
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2, #454550);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.14));
  color: var(--dsw-alias-label-primary, #ececf1);
  font: inherit;
}
.dsh-imessage-form input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary, #ff7f86); }
.dsh-imessage-form input:disabled { opacity: .6; }
.dsh-imessage-line { justify-content: space-between; gap: 16px; }
.dsh-imessage-line > div:first-child { display: grid; gap: 3px; }
.dsh-imessage-line strong {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 22px;
}
.dsh-imessage-health,
.dsh-imessage-commands dl { display: grid; gap: 8px; margin: 0; }
.dsh-imessage-health > div,
.dsh-imessage-commands dl > div { display: grid; grid-template-columns: minmax(110px, .36fr) 1fr; gap: 12px; }
.dsh-imessage-health dt,
.dsh-imessage-commands dt { color: var(--dsw-alias-label-tertiary, #8e8e99); }
.dsh-imessage-health dd,
.dsh-imessage-commands dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.dsh-imessage-commands {
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2, #383842);
  color: var(--dsw-alias-label-secondary, #b6b6c1);
  font-size: 13px;
}
.dsh-imessage-commands summary { color: var(--dsw-alias-label-primary, #ececf1); font-weight: 600; cursor: pointer; }
.dsh-imessage-commands dl { margin-top: 12px; }
.dsh-imessage-commands p { margin: 12px 0 0; }
.dsh-imessage-section code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow-wrap: anywhere;
}
.dsh-imessage-error-box {
  display: grid;
  justify-items: start;
  gap: 8px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff7f86) 46%, transparent);
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(255,80,90,.08));
  color: var(--dsw-alias-state-error-primary, #ff7f86);
  font-size: 13px;
}
.dsh-imessage-error-box ul { margin: 0; padding-left: 20px; }
@media (max-width: 640px) {
  .dsh-imessage-section { padding: 18px 14px 36px; }
  .dsh-imessage-card-title,
  .dsh-imessage-line { align-items: flex-start; flex-direction: column; }
  .dsh-imessage-health > div,
  .dsh-imessage-commands dl > div { grid-template-columns: 1fr; gap: 2px; }
}
`
